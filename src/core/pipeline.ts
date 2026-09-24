/**
 * The inbound pipeline (PLAN §3.2, §6.4).
 *
 *   dedupe -> stale check -> (transcribe) -> commands -> confirmations -> NLU -> act
 *
 * The order is the security order. Everything that can be answered
 * deterministically is answered before the LLM is reached: system commands,
 * tapped buttons, and a plain "כן" that answers a pending question all resolve
 * here, so a confirmation can never be re-interpreted by a model
 * (CLAUDE.md invariants 7 and 8).
 *
 * A voice note joins one step earlier: the audio is transcribed and graded, and
 * only a transcript the recognizer stands behind continues down this same path
 * (invariant 13, §6.10). Every answer to one leads with what was heard.
 *
 * Plain TypeScript throughout — no platform imports (invariant 11). The Durable
 * Object supplies the services and the clock.
 */
import type { InboundEvent, OutboundButton } from '../channels/types.js';
import { Repository } from './repo.js';
import type { Logger } from '../security/redact.js';
import type { VoiceTranscriber } from '../voice/transcribe.js';
import type { NluProvider } from '../nlu/provider.js';
import type { ReminderStore } from '../tools/reminder-store.js';
import type { PendingActions } from '../confirm/pending.js';
import type { UndoActions } from '../confirm/undo.js';
import type { GoogleStore } from '../google/store.js';
import type { CalendarClient } from '../google/calendar.js';
import type { Lang } from '../render/format-time.js';
import { matchCommand } from './router.js';
import { runButton, runIntent, runPlainConfirmation } from './orchestrator.js';
import type { Reply, TurnContext } from './orchestrator.js';
import { parseWithFallback } from '../nlu/provider.js';
import { toolCatalog } from '../tools/registry.js';
import { budgetState } from '../policy/window.js';
import { he } from '../render/he.js';
import { statusText } from '../render/status.js';
import { eventText } from '../render/events.js';
import { localPartsOf, offsetMinutesAt, ZONE } from '../time/tz.js';
import { STALE_MESSAGE_MS } from '../channels/whatsapp/limits.js';

/** The stateful collaborators the Durable Object owns and hands in. */
export type Services = {
  reminders: ReminderStore;
  pending: PendingActions;
  deferred: UndoActions;
  /** The fallback chain, in order. Empty means no parsing is available. */
  nlu: NluProvider[];
  /** Google's integration state. Absent only in tests that predate Phase 5. */
  google?: GoogleStore;
  /** Present once a grant exists; calendar tools answer "not connected" without it. */
  calendar?: CalendarClient;
  /** Where the one-time connect link points. */
  publicBaseUrl?: string;
};

export type PipelineDeps = {
  repo: Repository;
  log: Logger;
  now(): number;
  /** Keyed hash of the sender. The raw number never reaches this layer. */
  principal: string;
  /** Absent until a transcription provider is configured (§6.10). */
  transcribe?: VoiceTranscriber;
  /** Absent only in the Phase 1 tests, which predate the tool layer. */
  services?: Services;
};

export type PipelineOutcome =
  | {
      action: 'reply';
      text: string;
      buttons?: OutboundButton[];
      /** The next reminder moved; the caller re-arms its alarm. */
      rescheduleAlarm?: boolean;
    }
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
    return handleButtonReply(event, deps, now);
  }

  if (event.kind === 'audio') {
    return handleAudio(event, deps, now, stale);
  }

  return respondToText(event.text, { kind: 'text' }, event, deps, now, stale);
}

// -- buttons ------------------------------------------------------------------

async function handleButtonReply(
  event: Extract<InboundEvent, { kind: 'button' }>,
  deps: PipelineDeps,
  now: number,
): Promise<PipelineOutcome> {
  const { repo, log } = deps;

  if (!deps.services) {
    log.info('button_reply_unhandled', { wamid: event.wamid });
    repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
    return { action: 'none', reason: 'not_implemented' };
  }

  // Deterministic, and never near the LLM (invariant 7).
  const reply = await runButton(event.buttonId, turnOf(deps, event, now, { kind: 'text' }, 'he'));
  repo.markInboundOutcome(event.wamid, { decision: 'BUTTON' });
  return asOutcome(reply);
}

// -- voice --------------------------------------------------------------------

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
    event,
    deps,
    now,
    stale,
  );

  if (reply.action !== 'reply') return reply;

  // The echo goes on every answer, including the ones that worked. It is the
  // only place the transcript is ever shown, and it goes only to its author.
  return { ...reply, text: `${he.heard(outcome.text)}\n\n${reply.text}` };
}

// -- text ---------------------------------------------------------------------

async function respondToText(
  text: string,
  source: TextSource,
  event: Extract<InboundEvent, { kind: 'text' | 'audio' }>,
  deps: PipelineDeps,
  now: number,
  stale: boolean,
): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;

  // 1. System commands. Fixed patterns, never the LLM (PLAN §6.4).
  const command = matchCommand(text);
  if (command) {
    log.info('command', { wamid: event.wamid, intent: command.kind, stale, source: source.kind });
    repo.markInboundOutcome(event.wamid, { intent: command.kind, decision: 'ALLOW' });
    repo.audit({ ts: now, principal, tool: command.kind, tier: 0, decision: 'ALLOW', outcome: 'ok' });
    return { action: 'reply', text: renderCommand(command.kind, deps, now) };
  }

  if (!deps.services) {
    log.info('nlu_not_configured', { wamid: event.wamid, stale });
    repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
    return { action: 'reply', text: he.notUnderstood };
  }

  // 2. A plain "כן" answering a pending question. Also never the LLM: a
  //    confirmation that could be re-parsed is not a confirmation (§6.5).
  const plain = deps.services.pending.resolvePlainText(text, principal);
  if (plain.ok) {
    const reply = await runPlainConfirmation(plain.id, turnOf(deps, event, now, source, 'he'));
    repo.markInboundOutcome(event.wamid, { decision: 'CONFIRMED' });
    return asOutcome(reply);
  }
  if (!plain.ok && plain.reason === 'ambiguous') {
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY' });
    return { action: 'reply', text: statusText.confirmAmbiguous };
  }

  // 3. The LLM, at last, and only as a parser.
  const parsed = await parseWithFallback(deps.services.nlu, promptInputFor(text, now), log);
  if (!parsed.ok) {
    repo.bumpCounter(Repository.dayKey(now), 'fallbacks');
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: parsed.errorCode });
    repo.setLastErrorCode(`E_NLU_${parsed.errorCode.toUpperCase()}`);
    return { action: 'reply', text: he.notUnderstood };
  }

  const lang: Lang = parsed.draft.language;
  const reply = await runIntent(parsed.draft, turnOf(deps, event, now, source, lang));
  repo.markInboundOutcome(event.wamid, { intent: parsed.draft.intent, decision: 'ALLOW' });
  return asOutcome(reply);
}

// -- system commands ----------------------------------------------------------

function renderCommand(kind: string, deps: PipelineDeps, now: number): string {
  const { repo } = deps;

  switch (kind) {
    case 'help':
      return he.help;
    case 'ping':
      return he.pong;

    case 'pause':
      if (repo.isPaused()) return statusText.alreadyPaused;
      repo.setPaused(true);
      return statusText.paused;

    case 'resume':
      if (!repo.isPaused()) return statusText.alreadyRunning;
      repo.setPaused(false);
      return statusText.resumed;

    case 'budget':
      return statusText.budget(budgetState(monthlySentOf(repo, now)));

    case 'connect_google':
      return connectLinkFor(deps);

    case 'status':
      return statusText.status({
        connected: deps.services?.google?.isConnected() ?? false,
        pendingReminders: deps.services?.reminders.listUpcoming(deps.principal).length ?? 0,
        budget: budgetState(monthlySentOf(repo, now)),
        llmFallbacksToday: repo.counters(Repository.dayKey(now)).fallbacks,
        lastErrorCode: repo.lastErrorCode(),
        paused: repo.isPaused(),
      });

    default:
      return statusText.notAvailableYet;
  }
}

/**
 * The one-time link that starts the OAuth flow (PLAN §6.6).
 *
 * The link is a capability: anyone holding it can attach a Google account to
 * this assistant. So it is 256 random bits, single use, and dies in ten
 * minutes — and it is only ever sent to an allowlisted number.
 */
function connectLinkFor(deps: PipelineDeps): string {
  const google = deps.services?.google;
  const base = deps.services?.publicBaseUrl;
  if (!google || !base) return statusText.notAvailableYet;

  const link = google.createLink(deps.principal);
  const url = `${base.replace(/\/$/, '')}/oauth/google/start?id=${link.id}`;
  return eventText.connectLink(url, CONNECT_LINK_MINUTES, 'he');
}

/** Matches the TTL in `GoogleStore`. */
const CONNECT_LINK_MINUTES = 10;

// -- helpers ------------------------------------------------------------------

function turnOf(
  deps: PipelineDeps,
  event: Extract<InboundEvent, { kind: 'text' | 'audio' | 'button' }>,
  now: number,
  source: TextSource,
  lang: Lang,
): TurnContext {
  const services = deps.services;
  if (!services) throw new Error('E_SERVICES_MISSING');

  return {
    tool: {
      principal: deps.principal,
      nowMs: now,
      lang,
      repo: deps.repo,
      reminders: services.reminders,
      log: deps.log,
      lastInboundAt: deps.repo.lastInboundAt(deps.principal),
      monthlySent: monthlySentOf(deps.repo, now),
      ...(services.calendar ? { calendar: services.calendar } : {}),
    },
    pending: services.pending,
    deferred: services.deferred,
    messageSentAtMs: event.sentAtMs,
    forwarded: event.forwarded,
    paused: deps.repo.isPaused(),
    source: source.kind,
    ...(source.kind === 'voice' ? { voiceConfidence: source.confidence } : {}),
  };
}

function asOutcome(reply: Reply): PipelineOutcome {
  return {
    action: 'reply',
    text: reply.text,
    ...(reply.buttons ? { buttons: reply.buttons } : {}),
    ...(reply.rescheduleAlarm ? { rescheduleAlarm: true } : {}),
  };
}

function promptInputFor(text: string, now: number) {
  const local = localPartsOf(now, ZONE);
  const offset = offsetMinutesAt(now, ZONE);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');

  return {
    // The message is data. Instructions inside it never change the rules.
    text,
    nowLocalIso:
      `${local.year}-${pad(local.month)}-${pad(local.day)}` +
      `T${pad(local.hour)}:${pad(local.minute)}:00` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    weekday: WEEKDAY_NAMES[local.weekday] ?? 'Sunday',
    tools: toolCatalog(),
  };
}

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

function monthlySentOf(repo: Repository, now: number): number {
  return repo.counters(Repository.monthKey(now)).waSent;
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
