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
import type { DriveClient } from '../google/drive.js';
import type { GmailClient } from '../google/gmail.js';
import type { TasksClient } from '../google/tasks.js';
import type { GrantName } from '../google/grants.js';
import { DEFAULT_PLACE, findPlace, HOME_CITY_KEY } from '../lookup/place.js';
import type { DeviceLocation, InboundEvent, OutboundButton } from '../channels/types.js';
import { Repository } from './repo.js';
import { Stopwatch } from './timing.js';
import type { Stage } from './timing.js';
import type { Logger } from '../security/redact.js';
import type { VoiceTranscriber } from '../voice/transcribe.js';
import type { NluProvider } from '../nlu/provider.js';
import type { ReminderStore } from '../tools/reminder-store.js';
import type { PendingActions } from '../confirm/pending.js';
import type { OpenQuestion, OpenQuestions } from '../confirm/questions.js';
import type { UndoActions } from '../confirm/undo.js';
import type { GoogleStore } from '../google/store.js';
import type { IcalStore } from '../ical/store.js';
import type { BirthdayStore } from './birthdays.js';
import { refreshFeed } from '../ical/refresh.js';
import { checkFeedUrl } from '../ical/url.js';
import type { CalendarClient } from '../google/calendar.js';
import type { Lang } from '../render/format-time.js';
import { matchCommand } from './router.js';
import type { Command } from './router.js';
import { runButton, runIntent, runPlainConfirmation } from './orchestrator.js';
import type { ActionCard, Reply, TurnContext } from './orchestrator.js';
import { parseWithFallback } from '../nlu/provider.js';
import { applyAnswer, parseAnswer } from '../nlu/answer.js';
import { validateIntentDraft } from '../nlu/intent-schema.js';
import { checkNamedWeekdays } from '../nlu/weekday-check.js';
import type { CallDispatcher } from '../device/calls.js';
import type { DeviceStore } from '../device/store.js';
import type { AppOutbox } from '../channels/app/outbox.js';
import { PAIRING_TTL_MS } from '../device/store.js';
import { callText } from '../render/calls.js';
import { reAsk } from '../render/clarify.js';
import { toolCatalog } from '../tools/registry.js';
import { budgetState } from '../policy/window.js';
import { classifyMetaError } from '../channels/whatsapp/errors.js';
import { he } from '../render/he.js';
import { statusText } from '../render/status.js';
import { eventText } from '../render/events.js';
import { localPartsOf, offsetMinutesAt, ZONE } from '../time/tz.js';
import { STALE_MESSAGE_MS } from '../channels/limits.js';
import type { AgentProvider } from '../agent/provider.js';
import type { TokenBudget } from '../agent/budget.js';
import type { ConversationHistory } from '../agent/history.js';
import type { AgentLock } from '../agent/lock.js';
import { resumeAgentTurn, runAgentTurn } from '../agent/loop.js';
import type { AgentResult } from '../agent/loop.js';
import type { SuspendedTurns } from '../agent/turns.js';
import type { PhoneReadInput, PhoneReadResult } from '../tools/phone-reads.js';

/** The agent and what it keeps (PLAN §6.19). Absent: the parser answers, as before. */
export type AgentServices = {
  /** In order of preference. A turn runs on one of them. */
  providers: readonly AgentProvider[];
  /**
   * Asked, read-only, when none of `providers` could take the turn and the
   * parser found no tool in the words (2026-10-05).
   */
  fallbackProviders?: readonly AgentProvider[];
  budget: TokenBudget;
  history: ConversationHistory;
  lock: AgentLock;
  /** Turns waiting for the phone (§6.21). Absent: phone reads are never offered. */
  turns?: SuspendedTurns;
};

/** The stateful collaborators the Durable Object owns and hands in. */
export type Services = {
  reminders: ReminderStore;
  pending: PendingActions;
  /** The one clarifying question a sender may have open (§6.11). */
  questions: OpenQuestions;
  deferred: UndoActions;
  /** The fallback chain, in order. Empty means no parsing is available. */
  nlu: NluProvider[];
  /** Google's integration state. Absent only in tests that predate Phase 5. */
  google?: GoogleStore;
  /** The other Google grants — gmail, tasks, drive — each its own store (2026-10-01). */
  grants?: Partial<Record<GrantName, GoogleStore>>;
  /** Google Tasks, once its grant is connected. */
  tasks?: TasksClient;
  /** Gmail, once its grant is connected. */
  gmail?: GmailClient;
  /** Google Drive's file search, once its grant is connected. */
  drive?: DriveClient;
  /** Present once a grant exists; calendar tools answer "not connected" without it. */
  calendar?: CalendarClient;
  /** Where the one-time connect link points. */
  publicBaseUrl?: string;
  /** Subscribed iCal feeds (§6.15). Absent in tests that predate them. */
  ical?: IcalStore;
  /** The local birthday list (§6.16). */
  birthdays?: BirthdayStore;
  /** Supplied by the platform so a feed can be fetched. */
  fetchImpl?: typeof fetch;
  /** Reaches the paired phone (§6.17). Absent until calls are configured. */
  calls?: CallDispatcher;
  /** Pairing and unpairing the phone (§6.17). Absent without a device pepper. */
  devices?: DeviceStore;
  /** Messages waiting for the app (§6.18). Present only on the app channel. */
  outbox?: AppOutbox;
  /** The tool-calling agent (§6.19). Absent: free text goes to the parser. */
  agent?: AgentServices;
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
  /** Set by `handleInbound` for the turn it is handling (§6.14). */
  watch?: Stopwatch;
  /** The channel this turn arrived on. WhatsApp when absent (§6.18). */
  channel?: 'whatsapp' | 'app';
  /**
   * What the paired app said it can do, from its signed push-token update.
   * `cards` lets the agent offer phone actions (§6.20).
   */
  deviceCaps?: readonly string[];
};

export type PipelineOutcome =
  | {
      action: 'reply';
      text: string;
      buttons?: OutboundButton[];
      /** The next reminder moved; the caller re-arms its alarm. */
      rescheduleAlarm?: boolean;
      /**
       * For a voice note: the same answer without the echo of what was heard.
       * Anything stored — the app's outbox — keeps this one, because the
       * transcript is never written down (§6.10, §6.18).
       */
      withoutEcho?: string;
      /**
       * The reply carries a link that must stay a link: the one-time Google
       * connect link. Every other reply is defanged where it leaves (§6.19).
       */
      keepLinks?: true;
      /** A phone action for the app to claim (§6.20). */
      card?: ActionCard;
      /** Carries text someone else wrote: the app notifies generically (§6.21). */
      private?: true;
    }
  /** The agent's turn waits for the phone to read this (§6.21). */
  | { action: 'device_query'; queryId: string; query: PhoneReadInput }
  | {
      action: 'none';
      reason: 'duplicate' | 'status' | 'not_implemented' | 'reply_deferred';
      /** A failed delivery put a reminder back in the queue (§6.8). */
      rescheduleAlarm?: boolean;
    };

/** How the text reached us, and how much it can be trusted. */
type TextSource = { kind: 'text' } | { kind: 'voice'; confidence: 'high' | 'uncertain' };

export async function handleInbound(
  event: InboundEvent,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  // One stopwatch per turn, threaded through rather than global, so a test can
  // drive two turns at once and so nothing here is ambient state (§6.14).
  const watch = new Stopwatch();
  const outcome = await route(event, { ...deps, watch });

  // Numbers only, and the field names are a closed set — there is nowhere here
  // a message body could reach (§6.9).
  deps.log.info('turn', {
    wamid: event.wamid,
    kind: event.kind,
    action: outcome.action,
    ...(outcome.action === 'none' ? { reason: outcome.reason } : {}),
    ...watch.fields(),
  });

  return outcome;
}

async function route(event: InboundEvent, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;
  const now = deps.now();

  if (event.kind === 'status') {
    return recordDeliveryStatus(event, deps, now);
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

// -- delivery statuses --------------------------------------------------------

/**
 * A delivery status webhook (PLAN §6.8).
 *
 * This used to be logged and dropped, which left the system unable to tell an
 * *accepted* message from a *delivered* one — and the Cloud API answers 200
 * with a valid wamid for messages it never delivers. A reminder marked sent on
 * the strength of that 200 alone was, until the status arrived, the end of the
 * story: nothing would ever look at it again.
 *
 * No reply is ever sent from here. A status is Meta talking about a message,
 * not the user talking to us, and answering it would put the assistant in a
 * conversation with itself.
 */
function recordDeliveryStatus(
  event: Extract<InboundEvent, { kind: 'status' }>,
  deps: PipelineDeps,
  now: number,
): PipelineOutcome {
  const { repo, log } = deps;

  const failure = classifyMetaError(event.errorCode ?? null, null);

  const applied = repo.applyDeliveryStatus({
    wamid: event.wamid,
    status: event.status,
    atMs: now,
    ...(event.status === 'failed' ? { errorCode: failure.errorCode } : {}),
    ...(event.pricingCategory === undefined ? {} : { pricingCategory: event.pricingCategory }),
  });

  log.info('delivery_status', {
    wamid: event.wamid,
    status: event.status,
    ...(event.status === 'failed' ? { errorCode: failure.errorCode } : {}),
  });

  if (event.status === 'failed') {
    repo.setLastErrorCode(failure.errorCode, now);

    const reminderId = applied.failedReminderId;
    if (reminderId && deps.services) {
      // A reminder that Meta accepted and then did not deliver. Retry only what
      // is worth retrying: an undeliverable recipient or a shut window will
      // answer the same way five times and spend five messages saying it.
      const worthRetrying =
        failure.disposition === 'retry' || failure.disposition === 'back_off';

      const retrying = worthRetrying
        ? (deps.services.reminders.reopenForRetry(reminderId)?.retrying ?? false)
        : (deps.services.reminders.retireSent(reminderId), false);

      log.warn('reminder_delivery_failed', {
        errorCode: failure.errorCode,
        disposition: failure.disposition,
        retrying,
      });

      if (retrying) return { action: 'none', reason: 'status', rescheduleAlarm: true };
    }
  }

  return { action: 'none', reason: 'status' };
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

  const transcribe = deps.transcribe;
  const outcome = await timed(deps, 'voice', () =>
    transcribe({
      mediaId: event.mediaId,
      mimeType: event.mimeType,
      ...(event.bytes ? { bytes: event.bytes } : {}),
    }),
  );

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
  return { ...reply, text: `${he.heard(outcome.text)}\n\n${reply.text}`, withoutEcho: reply.text };
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
    return {
      action: 'reply',
      text: await renderCommand(command, deps, now),
      ...(command.kind === 'connect_google' ? { keepLinks: true } : {}),
    };
  }

  if (!deps.services) {
    log.info('nlu_not_configured', { wamid: event.wamid, stale });
    repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
    return { action: 'reply', text: he.notUnderstood };
  }

  // 2a. A plain "כן" or "אישור" answering a pending question. Also never the LLM: a
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

  // 2b. An answer to the one open question (PLAN §6.11). Before the parser,
  //     because "8" means nothing to a parser and everything to a question —
  //     and because answering costs no tokens at all.
  const open = deps.services.questions.peek(principal);
  if (open) {
    const answered = await answerOpenQuestion(open, text, source, event, deps, now);
    if (answered) return answered;
    // Not about the question. The user moved on, so the question goes and the
    // message is read from the top as a request of its own.
    deps.services.questions.clear(principal);
    log.info('question_abandoned', { tool: open.tool, asked: open.asked });
  }

  // 3. The agent (§6.19). It falls back to the parser below only when nothing
  //    ran — a fallback after a tool had run would run the message twice.
  let agentFailure: string | null = null;
  if (deps.services.agent) {
    const answered = await respondWithAgent(deps.services.agent, text, source, event, deps, now);
    if ('fellBack' in answered) agentFailure = answered.fellBack;
    else return answered;
  }

  // 3b. The LLM as a parser: the path before the agent, and its fallback.
  const nlu = deps.services.nlu;
  const parsed = await timed(deps, 'nlu', () =>
    parseWithFallback(nlu, promptInputFor(text, now), log),
  );
  if (!parsed.ok) {
    repo.bumpCounter(Repository.dayKey(now), 'fallbacks');
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: parsed.errorCode });
    repo.setLastErrorCode(`E_NLU_${parsed.errorCode.toUpperCase()}`, now);
    return { action: 'reply', text: agentFailure === null ? he.notUnderstood : he.agentFailed(agentFailure) };
  }

  // The agent answers what no tool covers; the parser cannot. After the agent
  // failed, "unsupported" is the failure speaking, not the wording.
  if (agentFailure !== null && parsed.draft.intent === 'unsupported') {
    // The fallback model may still answer — a question, or a read — but
    // never act: it is offered reads only (2026-10-05). Not when the turn
    // itself was the problem: it would be as long on the other model.
    const agent = deps.services.agent;
    if (agent?.fallbackProviders?.length && !TURN_SHAPE_FAILURES.has(agentFailure)) {
      const answered = await respondWithAgent(agent, text, source, event, deps, now, { readOnly: true });
      if (!('fellBack' in answered)) return answered;
    }
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: `E_AGENT_${agentFailure.toUpperCase()}` });
    return { action: 'reply', text: he.agentFailed(agentFailure) };
  }

  // 3a. Code reads the day the words name, and holds the model to it (§6.2).
  const checked = checkNamedWeekdays(parsed.draft, text);
  if (checked.mismatched.length > 0) {
    log.info('weekday_mismatch', {
      intent: checked.draft.intent,
      slotKeys: checked.mismatched.join(','),
    });
  }

  const lang: Lang = checked.draft.language;
  const reply = await timed(deps, 'act', () =>
    runIntent(checked.draft, turnOf(deps, event, now, source, lang), {
      dayInDoubt: checked.mismatched,
    }),
  );
  repo.markInboundOutcome(event.wamid, { intent: checked.draft.intent, decision: 'ALLOW' });
  return replyOutcome(reply, deps);
}

/** Failures of the turn itself, not of the model: another model would hit them too. */
const TURN_SHAPE_FAILURES: ReadonlySet<string> = new Set(['turn_token_cap', 'max_calls']);

/**
 * One agent turn (PLAN §6.19). Returns `fellBack`, with why, to hand the
 * message to the parser — only ever when no tool ran, so the fallback cannot
 * act twice (plan D1).
 *
 * The lock is taken here, synchronously, before the first await: while the
 * model is thinking, a second message from the same sender must not start a
 * second turn on the same history (plan C3).
 */
async function respondWithAgent(
  agent: AgentServices,
  text: string,
  source: TextSource,
  event: Extract<InboundEvent, { kind: 'text' | 'audio' }>,
  deps: PipelineDeps,
  now: number,
  /** The fallback model's read-only second try (2026-10-05). */
  options: { readOnly?: boolean } = {},
): Promise<PipelineOutcome | { fellBack: string }> {
  const { repo, log, principal } = deps;
  const turnId = event.wamid;
  const readOnly = options.readOnly === true;

  if (readOnly) {
    // The lock was let go after the first try. A newer message that took it
    // since, or left a turn waiting for the phone, is what the user is on now:
    // this one gives up quietly rather than cancel or overtake it. Checked and
    // taken in one synchronous step, before any await.
    if (agent.turns?.hasWaiting(principal) || !agent.lock.acquire(principal, turnId)) {
      log.info('agent_fallback_skipped', { wamid: event.wamid });
      return { fellBack: 'busy' };
    }
  } else if (!agent.lock.acquire(principal, turnId)) {
    log.info('agent_busy', { wamid: event.wamid });
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: 'E_AGENT_BUSY' });
    return { action: 'reply', text: he.agentBusy };
  }

  // A turn left waiting for the phone is not going to be continued now: this
  // newer message is what the user is talking about (§6.21).
  if (!readOnly) agent.turns?.supersede(principal);

  try {
    const lang = languageOf(text);
    // Each of the app's conversations keeps its own memory (2026-10-01).
    const conversation = event.conversationId ?? '';
    const history = await agent.history.recent(principal, conversation);
    const result = await timed(deps, 'agent', () =>
      runAgentTurn(
        {
          text,
          lang,
          nowMs: now,
          turn: turnOf(deps, event, now, source, lang),
          history,
          // Phone actions only where an app that runs cards will receive them (§6.20).
          cards: deps.channel === 'app' && (deps.deviceCaps ?? []).includes('cards'),
          // Phone reads only from an app that answers them, and only for typed
          // words: a suspended turn stores the message (§6.21, invariant 13).
          // Only the tools of the Google grants that are connected (2026-10-01).
          grants: {
            gmail: deps.services?.gmail !== undefined,
            tasks: deps.services?.tasks !== undefined,
            drive: deps.services?.drive !== undefined,
          },
          // Ignored on the read-only try, which is offered neither.
          readOnly,
          phoneReads:
            agent.turns !== undefined &&
            source.kind === 'text' &&
            deps.channel === 'app' &&
            (deps.deviceCaps ?? []).includes('device_query'),
        },
        { providers: readOnly ? (agent.fallbackProviders ?? []) : agent.providers, budget: agent.budget, log },
      ),
    );

    if (result.kind === 'suspend' && agent.turns) {
      const queryId = await agent.turns.suspend(principal, event.wamid, {
        ...result.state,
        ...(conversation === '' ? {} : { conversation }),
      });
      repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'DEVICE_QUERY' });
      log.info('agent_suspended', { wamid: event.wamid, tool: result.state.tool });
      return { action: 'device_query', queryId, query: result.state.query };
    }

    const settled = await settleAgentResult(
      result,
      source.kind === 'voice' ? he.voicePlaceholder : text,
      event.wamid,
      deps,
      now,
      conversation,
      readOnly,
    );
    if (settled) return settled;
    return { fellBack: result.kind === 'failed' ? result.errorCode : 'unknown' };
  } finally {
    agent.lock.release(principal, turnId);
  }
}

/**
 * The end of an agent turn, started now or resumed after the phone answered:
 * the fallback rule, the inbound record, the question, and the history.
 */
async function settleAgentResult(
  result: AgentResult,
  /** What the history keeps for the user's side: the words, or the voice placeholder. */
  userText: string,
  wamid: string,
  deps: PipelineDeps,
  now: number,
  /** The app's conversation, '' for the shared thread. */
  conversation: string,
  /** The read-only second try: the first already counted the fallback and its code. */
  secondTry = false,
): Promise<PipelineOutcome | null> {
  const { repo, log, principal } = deps;
  const agent = deps.services?.agent;

  if (result.kind === 'suspend') {
    // Only a turn that may suspend is offered a phone read; reaching here is a bug.
    repo.markInboundOutcome(wamid, { intent: 'agent', decision: 'ALLOW', errorCode: 'E_AGENT_PARTIAL' });
    return { action: 'reply', text: he.agentIncomplete };
  }

  if (result.kind === 'failed') {
    if (!secondTry) {
      repo.bumpCounter(Repository.dayKey(now), 'fallbacks');
      repo.setLastErrorCode(`E_AGENT_${result.errorCode.toUpperCase()}`, now);
    }
    log.info('agent_failed', { wamid, errorCode: result.errorCode, toolRan: result.toolRan });
    if (!result.toolRan) return null;

    // A read completed and the model did not get to word it: the code-rendered
    // read is a complete answer on its own.
    const fallback = result.readText ?? he.agentIncomplete;
    repo.markInboundOutcome(wamid, { intent: 'agent', decision: 'ALLOW', errorCode: 'E_AGENT_PARTIAL' });
    return { action: 'reply', text: fallback, ...(result.tainted ? { private: true as const } : {}) };
  }

  repo.markInboundOutcome(wamid, { intent: 'agent', decision: 'ALLOW' });
  const outcome = replyOutcome(result.reply, deps);

  if (outcome.action === 'reply' && agent) {
    await agent.history.append(
      principal,
      {
        // A transcript is never stored (invariant 13); the reply carries the context.
        user: userText,
        reply: outcome.text,
        tainted: result.tainted,
      },
      conversation,
    );
    if (result.tainted) return { ...outcome, private: true };
  }
  return outcome;
}

/**
 * The phone answered a read (§6.21): go on with the turn it suspended.
 *
 * The caller (the Durable Object) has already taken the row with `begin`, in
 * the same synchronous step as this function's first line, so the lock is
 * taken here before anything awaits. A lock held by someone else means a newer
 * turn started meanwhile; this one is then cancelled, never interleaved.
 */
export async function resumeFromPhone(
  request: {
    queryId: string;
    wamid: string;
    ciphertext: string;
    result: PhoneReadResult;
    /** The original message's signed timestamp, for the staleness rule. */
    sentAtMs: number;
  },
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;
  const agent = deps.services?.agent;
  const turns = agent?.turns;
  if (!agent || !turns) return { action: 'reply', text: he.agentIncomplete };

  if (!agent.lock.acquire(principal, request.wamid)) {
    turns.finish(request.queryId, 'superseded');
    log.info('agent_resume_superseded', { wamid: request.wamid });
    return { action: 'reply', text: he.phoneReadCancelled };
  }

  try {
    const state = await turns.open(request.queryId, principal, request.ciphertext);
    if (!state) {
      log.warn('agent_resume_unreadable', { wamid: request.wamid });
      repo.markInboundOutcome(request.wamid, { intent: 'agent', decision: 'ERROR', errorCode: 'E_AGENT_STATE' });
      return { action: 'reply', text: he.agentIncomplete };
    }

    const now = deps.now();
    const turn = turnOf(deps, { sentAtMs: request.sentAtMs, forwarded: false }, now, { kind: 'text' }, state.lang);
    const result = await timed(deps, 'agent', () =>
      resumeAgentTurn(state, request.result, turn, { providers: agent.providers, budget: agent.budget, log }),
    );
    log.info('agent_resumed', { wamid: request.wamid, readStatus: request.result.status, itemCount: request.result.items.length });

    const outcome = await settleAgentResult(result, state.text, request.wamid, deps, now, state.conversation ?? '');
    // No fallback here: the parser never sees a turn the phone has answered.
    return outcome ?? { action: 'reply', text: he.agentIncomplete };
  } finally {
    turns.finish(request.queryId);
    agent.lock.release(principal, request.wamid);
  }
}

/** Hebrew if there is any Hebrew in it; the assistant's default user writes Hebrew. */
function languageOf(text: string): Lang {
  return /[֐-׿]/.test(text) || !/[A-Za-z]/.test(text) ? 'he' : 'en';
}

/** Time a stage when a stopwatch is running, and simply run it when not. */
function timed<T>(deps: PipelineDeps, stage: Stage, body: () => Promise<T>): Promise<T> {
  return deps.watch ? deps.watch.time(stage, body) : body();
}

// -- clarification round-trip -------------------------------------------------

/**
 * Read this message as the answer to the question still open, or decline to.
 *
 * Returns null for "this is not about that question", which is the caller's cue
 * to forget the question and start over. Everything else is handled here.
 *
 * What an answer may do is deliberately narrow: it merges into the slots of the
 * tool that asked, and the merged draft then goes through the same validation,
 * the same `resolve` and the same policy decision as a first-time request. An
 * answer cannot reach a different tool, cannot skip a confirmation, and cannot
 * turn a refusal into an execution.
 */
async function answerOpenQuestion(
  open: OpenQuestion,
  text: string,
  source: TextSource,
  event: Extract<InboundEvent, { kind: 'text' | 'audio' }>,
  deps: PipelineDeps,
  now: number,
): Promise<PipelineOutcome | null> {
  const { repo, log, principal } = deps;
  const services = deps.services;
  if (!services) return null;

  const outcome = parseAnswer(open.asked, text);

  if (outcome.kind === 'not_an_answer') return null;

  if (outcome.kind === 'cancelled') {
    services.questions.clear(principal);
    log.info('question_cancelled', { tool: open.tool, asked: open.asked });
    repo.markInboundOutcome(event.wamid, { decision: 'CANCELLED' });
    return { action: 'reply', text: statusText.cancelled };
  }

  if (outcome.kind === 'incomplete') {
    // Still an answer, just not one that settles it — "בערב" names no hour
    // (R11). The question stays open and is asked again, more concretely.
    log.info('question_incomplete', { tool: open.tool, asked: open.asked });
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY' });
    return { action: 'reply', text: reAsk(open.asked, open.language) };
  }

  // Answered. The question is spent either way from here, including when the
  // merged request turns out to be unusable — leaving it open would re-answer
  // the same thing on the next message.
  services.questions.clear(principal);

  const merged = applyAnswer(open.tool, open.slots, outcome.patch);
  const validated =
    merged &&
    validateIntentDraft({
      intent: open.tool,
      slots: merged,
      language: open.language,
      missing: [],
      ambiguities: [],
    });

  if (!validated || !validated.ok) {
    // The stored slots crossed a JSON boundary, so the reassembled draft is
    // validated exactly like model output (invariant 3). Failing it is a bug,
    // not an attack — but it is answered the same way either case.
    log.warn('question_merge_invalid', {
      tool: open.tool,
      asked: open.asked,
      issues: validated ? validated.issues : ['unmappable_slot'],
    });
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: 'E_ANSWER_INVALID' });
    return { action: 'reply', text: he.notUnderstood };
  }

  log.info('question_answered', { tool: open.tool, asked: open.asked, source: source.kind });
  // A question asked in a tainted agent turn is answered under the same taint
  // (§6.19): the answer cannot finish, unconfirmed, what injected text began.
  const reply = await runIntent(validated.draft, {
    ...turnOf(deps, event, now, source, open.language),
    ...(open.tainted ? { tainted: true } : {}),
  });
  repo.markInboundOutcome(event.wamid, { intent: validated.draft.intent, decision: 'ALLOW' });
  return replyOutcome(reply, deps);
}

// -- system commands ----------------------------------------------------------

async function renderCommand(command: Command, deps: PipelineDeps, now: number): Promise<string> {
  const { repo } = deps;

  switch (command.kind) {
    case 'help':
      return deps.channel === 'app' ? he.helpApp : he.help;
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
      if (deps.channel === 'app') return statusText.budgetNotInApp;
      return statusText.budget(budgetState(monthlySentOf(repo, now)));

    case 'connect_google':
      return connectLinkFor(deps, command.grant);

    case 'forget':
      forgetConversation(deps);
      return he.forgotten;

    case 'pair':
      return pairSetting(command.off, deps);

    case 'digest':
      return digestSetting(command, deps);

    case 'ical':
      return icalSetting(command, deps, now);

    case 'city':
      return citySetting(command, deps);

    case 'birthday':
      return birthdaySetting(command, deps);

    case 'shabbat':
      if (command.set === null) {
        return repo.restHoldEnabled() ? statusText.restHoldUnchanged : statusText.restHoldOff;
      }
      repo.setRestHold(command.set);
      return command.set ? statusText.restHoldOn : statusText.restHoldTurnedOff;

    case 'status':
      return statusText.status({
        connected: deps.services?.google?.isConnected() ?? false,
        grants: (['gmail', 'tasks', 'drive'] as const).filter((grant) => deps.services?.grants?.[grant]?.isConnected()),
        pendingReminders: deps.services?.reminders.listUpcoming(deps.principal).length ?? 0,
        ...(deps.channel === 'app' ? {} : { budget: budgetState(monthlySentOf(repo, now)) }),
        llmFallbacksToday: repo.counters(Repository.dayKey(now)).fallbacks,
        undeliveredToday: repo.undeliveredSince(now - DAY_MS),
        digestHour: repo.digestHour(),
        restHold: repo.restHoldEnabled(),
        ical: icalStatus(deps),
        lastErrorCode: repo.lastErrorCode(),
        paused: repo.isPaused(),
      });

    default:
      return statusText.notAvailableYet;
  }
}

/**
 * `/pair` and `/pair off` (PLAN §6.17).
 *
 * The code is a capability, like the connect link: whoever types it into the
 * app becomes the phone calls are sent to. So it is 256 random bits, single
 * use, ten minutes, and only its hash is kept. It goes out on the same channel
 * the connect link does — the allowlisted chat — and nowhere else.
 */
async function pairSetting(off: boolean, deps: PipelineDeps): Promise<string> {
  const devices = deps.services?.devices;
  if (!devices) return callText.notConfigured('he');

  if (deps.channel === 'app') {
    // A code in a reply would be readable to anything intercepting the
    // connection; in the app a phone is paired only with a code typed in by
    // hand (§6.18).
    if (!off) return callText.pairNotInApp('he');

    const services = deps.services;
    // The conversation belongs to the phone being unpaired (plan D4).
    forgetConversation(deps);
    const revoked = deps.repo.transaction(() => {
      // Nothing may wait for a phone that is no longer ours. Reminders already
      // handed to the outbox go back in the queue; with no device paired they
      // are held until the next one is (§6.18).
      const cleared = services?.outbox?.clearForRevoke() ?? { reminderIds: [] };
      for (const id of cleared.reminderIds) services?.reminders.reopenForRetry(id);
      return devices.revoke(deps.principal);
    });
    return revoked > 0 ? callText.unpairedApp('he') : callText.nothingPaired('he');
  }

  if (off) {
    return devices.revoke(deps.principal) > 0 ? callText.unpaired('he') : callText.nothingPaired('he');
  }
  const { code } = await devices.createPairing(deps.principal);
  return callText.pairingCode(code, PAIRING_TTL_MS / 60_000, 'he');
}

/**
 * The one-time link that starts the OAuth flow (PLAN §6.6).
 *
 * The link is a capability: anyone holding it can attach a Google account to
 * this assistant. So it is 256 random bits, single use, and dies in ten
 * minutes — and it is only ever sent to an allowlisted number.
 */
function connectLinkFor(deps: PipelineDeps, grant: GrantName): string {
  const google = deps.services?.google;
  const base = deps.services?.publicBaseUrl;
  if (!google || !base) return statusText.notAvailableYet;

  // The link says which grant it is for; the callback stores the token there (§6.6).
  const link = google.createLink(deps.principal, grant);
  const url = `${base.replace(/\/$/, '')}/oauth/google/start?id=${link.id}`;
  return eventText.connectLink(url, CONNECT_LINK_MINUTES, 'he', grant);
}

/**
 * Read or change the digest hour (PLAN §6.12).
 *
 * `/digest` alone reports; `/digest 7` sets; `/digest off` stops. Deterministic
 * and nowhere near the parser, like every other setting: nothing received over
 * chat may change policy, and an hour is close enough to one that it is worth
 * keeping on the same side of that line (invariant 8).
 */
function digestSetting(command: Extract<Command, { kind: 'digest' }>, deps: PipelineDeps): string {
  const { repo } = deps;

  if (command.set === null) {
    const hour = repo.digestHour();
    return hour === null ? statusText.digestOff : statusText.digestUnchanged(hour);
  }

  if (command.set === 'off') {
    repo.setDigestHour(null);
    return statusText.digestTurnedOff;
  }

  repo.setDigestHour(command.set);
  return statusText.digestOn(command.set);
}

/**
 * Subscribe to, report on, or drop an iCal feed (PLAN §6.15).
 *
 * Subscribing fetches straight away rather than waiting for the nightly
 * refresh. The user has just pasted a link and wants to know whether it worked;
 * "I will tell you tomorrow" is not an answer, and a link that is wrong is
 * wrong now.
 */
/**
 * `/city` (2026-10-01): where weather and candle lighting are about. A new name
 * is checked against the geocoder first, and stored as the name it knows, so
 * a typo does not quietly move every forecast somewhere else.
 */
async function citySetting(command: Extract<Command, { kind: 'city' }>, deps: PipelineDeps): Promise<string> {
  const current = deps.repo.getSetting(HOME_CITY_KEY) ?? DEFAULT_PLACE.name;
  if (command.set === null) return statusText.cityIs(current, true);

  const fetchImpl = deps.services?.fetchImpl;
  const place = fetchImpl ? await findPlace(fetchImpl, command.set) : null;
  if (!place) return statusText.cityNotFound(command.set, current);
  deps.repo.setSetting(HOME_CITY_KEY, place.name);
  return statusText.cityIs(place.name, false);
}

async function icalSetting(
  command: Extract<Command, { kind: 'ical' }>,
  deps: PipelineDeps,
  now: number,
): Promise<string> {
  const store = deps.services?.ical;
  if (!store) return statusText.notAvailableYet;

  if (command.set === null) {
    const feed = store.feedFor(deps.principal);
    return feed === null
      ? statusText.icalNone
      : statusText.icalStatus(feed.eventCount, feed.lastError);
  }

  if (command.set === 'off') {
    return store.unsubscribe(deps.principal) ? statusText.icalRemoved : statusText.icalNone;
  }

  const checked = checkFeedUrl(command.set);
  if (!checked.ok) {
    deps.log.info('ical_url_rejected', { reason: checked.reason });
    return statusText.icalRejected(checked.reason);
  }

  const feed = store.subscribe(deps.principal, checked.url);
  const result = await refreshFeed({
    store,
    feed,
    nowMs: now,
    log: deps.log,
    ...(deps.services?.fetchImpl ? { fetchImpl: deps.services.fetchImpl } : {}),
  });

  if (result.status === 'failed') {
    // The subscription is kept: the link may be right and the server briefly
    // down, and the daily refresh will try again. `/ical` reports the error.
    return statusText.icalFetchFailed(result.errorCode ?? 'E_ICAL_UNKNOWN');
  }
  return result.events === 0 ? statusText.icalEmpty : statusText.icalSubscribed(result.events);
}

/** The subscribed feed's state for `/status`, or null when there is none. */
function icalStatus(deps: PipelineDeps): { events: number; lastError: string | null } | null {
  const feed = deps.services?.ical?.feedFor(deps.principal);
  return feed ? { events: feed.eventCount, lastError: feed.lastError } : null;
}

/** The local birthday list (PLAN §6.16). Deterministic, never the parser. */
function birthdaySetting(
  command: Extract<Command, { kind: 'birthday' }>,
  deps: PipelineDeps,
): string {
  const store = deps.services?.birthdays;
  if (!store) return statusText.notAvailableYet;

  switch (command.action.kind) {
    case 'malformed':
      return statusText.birthdayShape;

    case 'list':
      return statusText.birthdayList(store.list(deps.principal));

    case 'remove':
      return store.remove(deps.principal, command.action.name)
        ? statusText.birthdayRemoved(command.action.name)
        : statusText.birthdayNotFound(command.action.name);

    case 'add': {
      const { name, day, month } = command.action;
      const added = store.add({ principal: deps.principal, name, day, month });
      if (added.ok) return statusText.birthdayAdded(name, day, month);
      return added.reason === 'invalid_date'
        ? statusText.birthdayBadDate
        : statusText.birthdayListFull;
    }
  }
}

/** `/forget` and `/pair off`: the agent's history and any lock go (§6.19). */
function forgetConversation(deps: PipelineDeps): void {
  const agent = deps.services?.agent;
  if (!agent) return;
  agent.history.wipe(deps.principal);
  agent.lock.wipe(deps.principal);
  agent.turns?.wipe(deps.principal);
}

/** Matches the TTL in `GoogleStore`. */
const CONNECT_LINK_MINUTES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// -- helpers ------------------------------------------------------------------

function turnOf(
  deps: PipelineDeps,
  event: Pick<Extract<InboundEvent, { kind: 'text' | 'audio' | 'button' }>, 'sentAtMs' | 'forwarded'> & {
    location?: DeviceLocation;
  },
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
      ...(deps.channel ? { channel: deps.channel } : {}),
      ...(services.calendar ? { calendar: services.calendar } : {}),
      ...(services.ical ? { ical: services.ical } : {}),
      ...(services.calls ? { calls: services.calls } : {}),
      ...(services.fetchImpl ? { fetchImpl: services.fetchImpl } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(services.tasks ? { tasks: services.tasks } : {}),
      ...(services.gmail ? { gmail: services.gmail } : {}),
      ...(services.drive ? { drive: services.drive } : {}),
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
  if (reply.silent) return { action: 'none', reason: 'reply_deferred' };
  return {
    action: 'reply',
    text: reply.text,
    ...(reply.buttons ? { buttons: reply.buttons } : {}),
    ...(reply.rescheduleAlarm ? { rescheduleAlarm: true } : {}),
    ...(reply.card ? { card: reply.card } : {}),
  };
}

/**
 * Send the reply, and remember the question if it asked one.
 *
 * Storing it here rather than inside `runIntent` keeps the orchestrator free of
 * the store, and keeps writing a question and reading one back in the same
 * file — they are two halves of one rule and drift apart if separated.
 */
function replyOutcome(reply: Reply, deps: PipelineDeps): PipelineOutcome {
  if (reply.question && deps.services) {
    deps.services.questions.open({ principal: deps.principal, ...reply.question });
  }
  return asOutcome(reply);
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
