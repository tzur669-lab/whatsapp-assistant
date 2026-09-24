/**
 * The Phase 1 pipeline: dedupe -> stale check -> deterministic router -> reply.
 *
 * NLU, tools, policy, and confirmations arrive in later phases and slot in
 * where `handleText` currently falls through. Plain TypeScript, no platform
 * imports (CLAUDE.md invariant 11).
 */
import type { InboundEvent } from '../channels/types.js';
import type { Repository } from './repo.js';
import type { Logger } from '../security/redact.js';
import { matchCommand } from './router.js';
import { he } from '../render/he.js';
import { STALE_MESSAGE_MS } from '../channels/whatsapp/limits.js';

export type PipelineDeps = {
  repo: Repository;
  log: Logger;
  now(): number;
  /** Keyed hash of the sender. The raw number never reaches this layer. */
  principal: string;
};

export type PipelineOutcome =
  | { action: 'reply'; text: string }
  | { action: 'none'; reason: 'duplicate' | 'status' | 'not_implemented' };

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

  const command = matchCommand(event.text);
  if (command) {
    log.info('command', { wamid: event.wamid, intent: command.kind, stale });
    repo.markInboundOutcome(event.wamid, { intent: command.kind, decision: 'ALLOW' });
    repo.audit({ ts: now, principal, tool: command.kind, tier: 0, decision: 'ALLOW', outcome: 'ok' });
    return { action: 'reply', text: renderCommand(command.kind) };
  }

  // Free text reaches NLU in Phase 3. Until then it is acknowledged, not guessed at.
  log.info('nlu_not_implemented', { wamid: event.wamid, stale });
  repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
  return { action: 'reply', text: he.notUnderstood };
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
