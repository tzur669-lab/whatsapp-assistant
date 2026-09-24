/**
 * Intent -> decision -> action (PLAN §6.4, §6.5).
 *
 * This is where the pieces meet, and the order is the whole design:
 *
 *   resolve   code turns slots into a complete input, or a question
 *   decide    policy reads tier, staleness, pause, limits — never the message
 *   act       Tier 0/1 run now; Tier 2/3 are written down and previewed
 *
 * Policy runs on the **resolved** input, not on the draft: the far-future rule
 * needs an instant, and an unresolvable request never reaches policy at all.
 *
 * Confirmations do not come back through here. A button reply is matched against
 * a stored row and executes that row's input (`runButton`), so a second reading
 * of the same words can never change what happens (CLAUDE.md invariant 7).
 *
 * One command produces at most one action and one reply (invariant 10).
 */
import type { IntentDraft } from '../nlu/intent-schema.js';
import type { OutboundButton } from '../channels/types.js';
import { decide } from '../policy/engine.js';
import { DEFAULT_LIMITS } from '../policy/engine.js';
import type { PolicyResult } from '../policy/engine.js';
import { REGISTRY } from '../tools/registry.js';
import type { ToolName } from '../tools/registry.js';
import { REMINDER_TOOLS } from '../tools/reminders.js';
import { calendarListEvents } from '../tools/calendar-read.js';
import type { ExecuteResult, ToolContext, ToolDefinition } from '../tools/types.js';
import { ToolInputError } from '../tools/types.js';
import { buttonId, parseButtonId } from '../confirm/pending.js';
import type { PendingActions } from '../confirm/pending.js';
import { SNOOZE_EXPIRY_MS } from '../confirm/undo.js';
import type { UndoActions } from '../confirm/undo.js';
import { renderClarify } from '../render/clarify.js';
import { buttonLabels, reminderText } from '../render/reminders.js';
import { statusText } from '../render/status.js';
import { he } from '../render/he.js';
import type { Lang } from '../render/format-time.js';
import { localPartsOf } from '../time/tz.js';

export type Reply = {
  text: string;
  buttons?: OutboundButton[];
  /** Set when state changed in a way that moves the next alarm. */
  rescheduleAlarm?: boolean;
};

export type TurnContext = {
  tool: ToolContext;
  pending: PendingActions;
  /** Tier 1 undos and snooze offers share this store (see `confirm/undo.ts`). */
  deferred: UndoActions;
  /** Meta's timestamp, for the staleness rule. */
  messageSentAtMs: number;
  forwarded: boolean;
  paused: boolean;
  source: 'text' | 'voice';
  voiceConfidence?: 'high' | 'uncertain';
};

/** The tools with an executable body. The rest parse but cannot yet run. */
const IMPLEMENTED: Partial<Record<ToolName, ToolDefinition>> = {
  ...REMINDER_TOOLS,
  'calendar.list_events': calendarListEvents,
};

export async function runIntent(draft: IntentDraft, turn: TurnContext): Promise<Reply> {
  const ctx = turn.tool;

  if (draft.intent === 'unsupported') {
    ctx.log.info('intent_unsupported', {});
    return { text: he.notUnderstood };
  }

  const tool = IMPLEMENTED[draft.intent];
  if (!tool) {
    ctx.log.info('tool_not_implemented', { tool: draft.intent });
    return { text: statusText.notAvailableYet };
  }

  // 1. Resolve. Everything the model left out is decided here or asked about.
  let resolved;
  try {
    resolved = tool.resolve(draft.slots, ctx);
  } catch (error) {
    ctx.log.error('resolve_failed', {
      tool: draft.intent,
      errorCode: error instanceof Error ? error.message : 'E_UNKNOWN',
    });
    return { text: he.internalError };
  }

  if (resolved.kind === 'clarify') {
    ctx.log.info('clarify', { tool: draft.intent, reason: resolved.clarify.code });
    audit(turn, draft.intent, null, 'CLARIFY', resolved.clarify.code);
    return { text: renderClarify(resolved.clarify, ctx.lang) };
  }

  // 2. Decide, on the resolved input.
  const decision = decide(draft.intent, {
    nowMs: ctx.nowMs,
    messageSentAtMs: turn.messageSentAtMs,
    forwarded: turn.forwarded,
    paused: turn.paused,
    usage: ctx.repo.toolUsage(ctx.principal, draft.intent, ctx.nowMs),
    limits: DEFAULT_LIMITS,
    horizonExceeded: resolved.needsConfirm === true,
    source: turn.source,
    ...(turn.voiceConfidence ? { voiceConfidence: turn.voiceConfidence } : {}),
  });

  ctx.log.info('policy_decision', {
    tool: draft.intent,
    tier: decision.tier,
    decision: decision.decision,
    reason: decision.reason,
    reasons: decision.allReasons,
  });

  // 3. Act.
  switch (decision.decision) {
    case 'DENY':
      audit(turn, draft.intent, decision, 'DENY', decision.reason);
      return { text: decision.reason === 'paused' ? statusText.paused : statusText.rateLimited };

    case 'CONFIRM':
      return askToConfirm(tool, resolved.input, decision, turn);

    case 'CLARIFY':
      return { text: he.notUnderstood };

    case 'ALLOW':
      return execute(tool, resolved.input, decision, turn);
  }
}

// -- confirmations ------------------------------------------------------------

function askToConfirm(
  tool: ToolDefinition,
  input: unknown,
  decision: PolicyResult,
  turn: TurnContext,
): Reply {
  const ctx = turn.tool;
  const summary = tool.preview(input, ctx.lang);

  const action = turn.pending.create({
    tool: tool.name,
    input,
    summary,
    tier: decision.tier ?? 0,
    principal: ctx.principal,
  });

  audit(turn, tool.name, decision, 'CONFIRM', decision.reason, action.id);

  return {
    text: statusText.confirmPrompt(summary),
    buttons: [
      { id: buttonId('pa', action.id, action.nonce, 'ok'), title: buttonLabels.confirm(ctx.lang) },
      { id: buttonId('pa', action.id, action.nonce, 'no'), title: buttonLabels.cancel(ctx.lang) },
    ],
  };
}

// -- execution ----------------------------------------------------------------

async function execute(
  tool: ToolDefinition,
  input: unknown,
  decision: PolicyResult,
  turn: TurnContext,
): Promise<Reply> {
  const ctx = turn.tool;

  let result: ExecuteResult;
  try {
    result = await tool.execute(input, ctx);
  } catch (error) {
    const code = error instanceof ToolInputError ? error.message : 'E_TOOL_FAILED';
    ctx.log.error('execute_failed', { tool: tool.name, errorCode: code });
    audit(turn, tool.name, decision, 'ALLOW', 'error');
    return { text: he.internalError };
  }

  audit(turn, tool.name, decision, 'ALLOW', 'ok', result.externalRef);

  // Tier 1 executes immediately, so the reply carries the way back.
  if (decision.undoable && result.compensating !== undefined && tool.undo) {
    const offer = turn.deferred.offer({
      tool: tool.name,
      compensating: result.compensating,
      principal: ctx.principal,
    });
    return {
      text: result.text,
      buttons: [
        { id: buttonId('undo', offer.id, offer.nonce, 'ok'), title: buttonLabels.undo(ctx.lang) },
      ],
      ...(result.rescheduleAlarm ? { rescheduleAlarm: true } : {}),
    };
  }

  return { text: result.text, ...(result.rescheduleAlarm ? { rescheduleAlarm: true } : {}) };
}

// -- button replies -----------------------------------------------------------

/**
 * Handle a tapped button. No LLM, no re-parsing: the id names a stored row, the
 * row's gates are checked atomically, and the row's own input is what runs.
 */
export async function runButton(raw: string, turn: TurnContext): Promise<Reply> {
  const ctx = turn.tool;
  const parsed = parseButtonId(raw);
  if (!parsed) {
    ctx.log.warn('button_malformed', {});
    return { text: statusText.confirmNotFound };
  }

  switch (parsed.kind) {
    case 'pa':
      return parsed.verb === 'ok'
        ? confirmPending(parsed.id, parsed.nonce, turn)
        : cancelPending(parsed.id, parsed.nonce, turn);
    case 'undo':
      return runDeferred(parsed.id, parsed.nonce, turn, 0);
    case 'snooze':
      return runDeferred(parsed.id, parsed.nonce, turn, snoozeMinutes(parsed.verb));
  }
}

/**
 * A plain "כן" that answered the one open question. It runs the same body as a
 * tapped button, so there is no second confirmation path to drift from the
 * first (PLAN §6.5).
 */
export function runPlainConfirmation(id: string, turn: TurnContext): Promise<Reply> {
  return confirmPending(id, null, turn);
}

async function confirmPending(id: string, nonce: string | null, turn: TurnContext): Promise<Reply> {
  const ctx = turn.tool;
  const checked =
    nonce === null
      ? turn.pending.confirmResolved(id, ctx.principal)
      : turn.pending.confirm(id, nonce, ctx.principal);

  if (!checked.ok) {
    ctx.log.info('confirm_rejected', { reason: checked.reason });
    return { text: confirmFailureText(checked.reason) };
  }

  const tool = IMPLEMENTED[checked.action.tool as ToolName];
  if (!tool) return { text: statusText.notAvailableYet };

  try {
    // The stored input, never a re-parse of the original message.
    const result = await tool.execute(checked.action.input, ctx);
    audit(turn, tool.name, null, 'CONFIRMED', 'ok', checked.action.id);
    return { text: result.text, ...(result.rescheduleAlarm ? { rescheduleAlarm: true } : {}) };
  } catch (error) {
    ctx.log.error('confirmed_execute_failed', {
      tool: checked.action.tool,
      errorCode: error instanceof Error ? error.message : 'E_UNKNOWN',
    });
    audit(turn, tool.name, null, 'CONFIRMED', 'error', checked.action.id);
    return { text: he.internalError };
  }
}

function cancelPending(id: string, nonce: string, turn: TurnContext): Reply {
  const result = turn.pending.cancel(id, nonce, turn.tool.principal);
  return { text: result.ok ? statusText.cancelled : confirmFailureText(result.reason) };
}

/**
 * Run an undo or a snooze. Both are one-shot stored actions with the same
 * gates; the only difference is what they do once they pass.
 */
async function runDeferred(
  id: string,
  nonce: string,
  turn: TurnContext,
  snoozeBy: number,
): Promise<Reply> {
  const ctx = turn.tool;
  const used = turn.deferred.use(id, nonce, ctx.principal);

  if (!used.ok) {
    ctx.log.info('deferred_rejected', { reason: used.reason });
    return { text: used.reason === 'expired' ? statusText.confirmExpired : statusText.confirmNotFound };
  }

  if (used.tool === SNOOZE_TOOL) {
    return snooze(used.compensating, snoozeBy, turn);
  }

  const tool = IMPLEMENTED[used.tool as ToolName];
  if (!tool?.undo) return { text: statusText.notAvailableYet };

  try {
    const result = await tool.undo(used.compensating, ctx);
    audit(turn, tool.name, null, 'UNDO', 'ok');
    return { text: result.text, rescheduleAlarm: true };
  } catch (error) {
    ctx.log.error('undo_failed', {
      tool: used.tool,
      errorCode: error instanceof Error ? error.message : 'E_UNKNOWN',
    });
    return { text: he.internalError };
  }
}

// -- snooze -------------------------------------------------------------------

export const SNOOZE_TOOL = 'reminders.snooze';

function snoozeMinutes(verb: string): number {
  if (verb === 'm10') return 10;
  if (verb === 'h1') return 60;
  return 0; // "done" — the offer is consumed and nothing is rescheduled.
}

function snooze(compensating: unknown, minutes: number, turn: TurnContext): Reply {
  const ctx = turn.tool;
  const record = (compensating ?? {}) as { text?: unknown; tz?: unknown };
  const text = typeof record.text === 'string' ? record.text : '';
  const tz = typeof record.tz === 'string' ? record.tz : 'Asia/Jerusalem';

  if (minutes === 0 || text.length === 0) {
    return { text: ctx.lang === 'he' ? 'סומן כבוצע.' : 'Marked done.' };
  }

  const dueAtUtc = ctx.nowMs + minutes * 60_000;
  ctx.reminders.schedule({
    principal: ctx.principal,
    text,
    dueAtUtc,
    localWallTime: '',
    tz,
  });

  audit(turn, SNOOZE_TOOL, null, 'ALLOW', 'ok');
  return {
    text: reminderText.created({ id: '', text, local: localPartsOf(dueAtUtc, tz) }, ctx.lang),
    rescheduleAlarm: true,
  };
}

/** Buttons offered alongside a delivered reminder. */
export function snoozeButtons(offerId: string, nonce: string, lang: Lang): OutboundButton[] {
  return [
    { id: buttonId('snooze', offerId, nonce, 'm10'), title: buttonLabels.snooze10(lang) },
    { id: buttonId('snooze', offerId, nonce, 'h1'), title: buttonLabels.snooze60(lang) },
    { id: buttonId('snooze', offerId, nonce, 'done'), title: buttonLabels.done(lang) },
  ];
}

export { SNOOZE_EXPIRY_MS };

// -- helpers ------------------------------------------------------------------

function confirmFailureText(reason: string): string {
  switch (reason) {
    case 'expired':
      return statusText.confirmExpired;
    case 'not_pending':
      return statusText.confirmNotFound;
    case 'not_found':
      return statusText.confirmNotFound;
    default:
      // wrong_sender, bad_nonce, input_changed: all mean "this tap does not
      // match a live request of yours". Saying which would be a probing oracle.
      return statusText.confirmNotFound;
  }
}

function audit(
  turn: TurnContext,
  tool: string,
  decision: PolicyResult | null,
  verdict: string,
  outcome: string,
  externalRef?: string,
): void {
  turn.tool.repo.audit({
    ts: turn.tool.nowMs,
    principal: turn.tool.principal,
    tool,
    tier: decision?.tier ?? REGISTRY[tool as ToolName]?.tier ?? null,
    decision: verdict,
    outcome,
    externalRef: externalRef ?? null,
  });
}
