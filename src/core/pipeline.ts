/**
 * The pipeline: dedupe -> stale check -> (transcribe) -> deterministic router -> reply.
 *
 * A voice note joins the same path as typed text, one step earlier: the audio is
 * transcribed, the transcript is graded, and only a transcript the recognizer
 * stands behind continues. From there the two are treated identically, which is
 * the point — voice must not grow a second set of rules that can drift from the
 * first (PLAN §6.10).
 *
 * The one visible difference is that every answer to a voice note leads with
 * what was heard. Typed text is on the user's screen already; a transcript is
 * not, and acting on words nobody has seen is exactly the failure to avoid.
 *
 * NLU, tools, policy, and confirmations arrive in later phases and slot in where
 * `respondToText` currently falls through. Plain TypeScript, no platform imports
 * (CLAUDE.md invariant 11).
 */
import type { InboundEvent } from '../channels/types.js';
import type { Repository } from './repo.js';
import type { Logger } from '../security/redact.js';
import type { VoiceTranscriber } from '../voice/transcribe.js';
import { matchCommand } from './router.js';
import { he } from '../render/he.js';
import { STALE_MESSAGE_MS } from '../channels/whatsapp/limits.js';

export type PipelineDeps = {
  repo: Repository;
  log: Logger;
  now(): number;
  /** Keyed hash of the sender. The raw number never reaches this layer. */
  principal: string;
  /**
   * Absent until a transcription provider is configured. Voice notes are then
   * answered as an unsupported type rather than silently ignored.
   */
  transcribe?: VoiceTranscriber;
};

export type PipelineOutcome =
  | { action: 'reply'; text: string }
  | { action: 'none'; reason: 'duplicate' | 'status' | 'not_implemented' };

/** How the text reached us, and how much it can be trusted. */
type TextSource = { kind: 'text' } | { kind: 'voice'; confidence: 'high' | 'uncertain' };

export async function handleInbound(
  event: InboundEvent,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;
  const now = deps.now();

  if (event.kind === 'status') {
    log.debug('delivery_status', { wamid: event.wamid, status: event.status });
    return { action: 'none', reason: 'status' };
  }

  const fresh = repo.recordInbound({
    wamid: event.wamid,
    principal,
    receivedAt: now,
    sentAt: event.sentAtMs,
    kind: event.kind,
  });

  if (!fresh) {
    log.info('duplicate_dropped', { wamid: event.wamid });
    return { action: 'none', reason: 'duplicate' };
  }

  repo.touchWindow(principal, now);

  const stale = now - event.sentAtMs > STALE_MESSAGE_MS;

  if (event.kind === 'unsupported') {
    log.info('unsupported_type', { wamid: event.wamid, messageType: event.messageType });
    repo.markInboundOutcome(event.wamid, { decision: 'UNSUPPORTED' });
    return { action: 'reply', text: he.unsupportedType };
  }

  if (event.kind === 'button') {
    // Button replies are handled deterministically by src/confirm/ (Phase 4+).
    log.info('button_reply_unhandled', { wamid: event.wamid });
    repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
    return { action: 'none', reason: 'not_implemented' };
  }

  if (event.kind === 'audio') {
    return handleAudio(event, deps, now, stale);
  }

  return respondToText(event.text, { kind: 'text' }, event.wamid, deps, now, stale);
}

async function handleAudio(
  event: Extract<InboundEvent, { kind: 'audio' }>,
  deps: PipelineDeps,
  now: number,
  stale: boolean,
): Promise<PipelineOutcome> {
  const { repo, log } = deps;

  if (!deps.transcribe) {
    log.info('voice_not_configured', { wamid: event.wamid });
    repo.markInboundOutcome(event.wamid, { decision: 'UNSUPPORTED' });
    return { action: 'reply', text: he.unsupportedType };
  }

  const outcome = await deps.transcribe({ mediaId: event.mediaId, mimeType: event.mimeType });

  if (outcome.status !== 'ok') {
    // Nothing usable came back. Say which of the fixable things went wrong, and
    // never guess at what the recording might have meant (invariant 12).
    log.info('voice_rejected', { wamid: event.wamid, status: outcome.status });
    repo.markInboundOutcome(event.wamid, {
      decision: 'CLARIFY',
      errorCode: `E_VOICE_${outcome.status.toUpperCase()}`,
    });
    return { action: 'reply', text: unclearReply(outcome) };
  }

  const reply = await respondToText(
    outcome.text,
    { kind: 'voice', confidence: outcome.confidence },
    event.wamid,
    deps,
    now,
    stale,
  );

  if (reply.action !== 'reply') return reply;

  // The echo goes on every answer, including the ones that worked. It is the
  // only place the transcript is ever shown, and it goes only to its author.
  return { action: 'reply', text: `${he.heard(outcome.text)}\n\n${reply.text}` };
}

async function respondToText(
  text: string,
  source: TextSource,
  wamid: string,
  deps: PipelineDeps,
  now: number,
  stale: boolean,
): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;

  const command = matchCommand(text);
  if (command) {
    log.info('command', { wamid, intent: command.kind, stale, source: source.kind });
    repo.markInboundOutcome(wamid, { intent: command.kind, decision: 'ALLOW' });
    repo.audit({ ts: now, principal, tool: command.kind, tier: 0, decision: 'ALLOW', outcome: 'ok' });
    return { action: 'reply', text: renderCommand(command.kind) };
  }

  // Free text reaches NLU in Phase 3. Until then it is acknowledged, not guessed at.
  log.info('nlu_not_implemented', { wamid, stale, source: source.kind });
  repo.markInboundOutcome(wamid, { decision: 'NOT_IMPLEMENTED' });
  return { action: 'reply', text: he.notUnderstood };
}

/** One reply per way a recording can be unusable, each naming what to do about it. */
function unclearReply(outcome: { status: 'unclear' | 'too_long' | 'failed'; reason?: string }): string {
  if (outcome.status === 'too_long') return he.voiceTooLong;
  if (outcome.status === 'failed') return he.voiceFailed;

  switch (outcome.reason) {
    case 'silence':
      return he.voiceSilent;
    case 'unknown_language':
      return he.voiceLanguage;
    default:
      return he.voiceUnclear;
  }
}

function renderCommand(kind: string): string {
  switch (kind) {
    case 'help':
      return he.help;
    case 'ping':
      return he.pong;
    default:
      // /status, /pause, /resume, /budget, /connect google land in Phases 5 and 7.
      return he.notUnderstood;
  }
}
