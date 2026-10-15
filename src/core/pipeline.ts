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
import type { NoteStore } from '../tools/note-store.js';
import type { ListStore } from '../tools/list-store.js';
import type { HoldingStore } from '../tools/holding-store.js';
import type { RoutineStore } from '../tools/routine-store.js';
import type { ScreenStore } from '../tools/screen-store.js';
import { namesScreenTask } from '../tools/screen.js';
import { namesRoutineBuild } from '../tools/routine-draft.js';
import type { DraftStore } from '../tools/routine-draft-store.js';
import { screenText } from '../render/screen.js';
import { buttonId, parseButtonId } from '../confirm/pending.js';
import { foldForMatch } from '../tools/match.js';
import type { QuoteSources } from '../lookup/quotes.js';
import { marketWordsIn } from '../tools/portfolio.js';
import type { FactStore } from '../tools/fact-store.js';
import type { ExpenseStore } from '../tools/expense-store.js';
import type { DriveClient } from '../google/drive.js';
import type { ContactsClient } from '../google/contacts.js';
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
import type { ImageInput, ImageRead } from '../vision/read-image.js';
import { composeImage } from '../channels/app/shared.js';
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
import { dataSourceOf, toolCatalog } from '../tools/registry.js';
import { budgetState } from '../policy/window.js';
import { classifyMetaError } from '../channels/whatsapp/errors.js';
import { he } from '../render/he.js';
import { missText } from '../render/misses.js';
import { examplesFor } from '../render/fallback.js';
import { factText, personalQuestion } from '../render/personal.js';
import type { Exchange, ExchangeLog } from './exchanges.js';
import { matchGroups, namesRememberAboutMe } from '../agent/tool-groups.js';
import type { GroupName } from '../agent/tool-groups.js';
import { statusText } from '../render/status.js';
import { eventText } from '../render/events.js';
import { localPartsOf, offsetMinutesAt, ZONE } from '../time/tz.js';
import { STALE_MESSAGE_MS } from '../channels/limits.js';
import type { AgentProvider } from '../agent/provider.js';
import type { MessageScope, TokenBudget } from '../agent/budget.js';
import { meterParsers, newMessageScope } from '../agent/budget.js';
import type { ConversationHistory } from '../agent/history.js';
import { provenanceOf, replayByConsent } from '../agent/history.js';
import type { AgentLock } from '../agent/lock.js';
import { resumeAfterConsent, resumeAgentTurn, runAgentTurn } from '../agent/loop.js';
import { mayInherit } from '../agent/last-selection.js';
import { singleHttpsUrl } from '../lookup/web-page.js';
import type { PageText } from '../lookup/web-page.js';
import { namesWatch } from '../tools/watch.js';
import { namesFollowUp } from '../tools/followup.js';
import { namesMonthlyPack } from '../tools/monthly-pack.js';
import { namesArchive } from '../tools/archive.js';
import { namesDocument } from '../tools/docs.js';
import { restoreNewest } from './mail-archive.js';
import { archiveText } from '../render/archive.js';
import { watchText } from '../render/watches.js';
import { followUpText } from '../render/followups.js';
import { suggestText } from '../render/suggestions.js';
import { monthlyText } from '../render/monthly.js';
import type { WatchStore } from '../tools/watch-store.js';
import type { FollowUpStore } from '../tools/followup-store.js';
import type { SuggestionStore } from '../tools/suggestion-store.js';
import type { ArchiveStore } from '../tools/archive-store.js';
import type { LastSelections } from '../agent/last-selection.js';
import type { AgentResult, ConsentDecision } from '../agent/loop.js';
import type { SuspendedTurns } from '../agent/turns.js';
import type { PhoneReadInput, PhoneReadResult } from '../tools/phone-reads.js';
import { CONSENT_REVOKE_TOOL, consentSourceOf, echoesOwnInput, isConsentSource, parseConsentButton, revokeButtonId } from '../agent/consents.js';
import type { ConsentButton, ConversationConsents } from '../agent/consents.js';
import type { ConsentSource } from '../tools/registry.js';
import { consentButtons, consentText } from '../render/consent.js';
import { LEARN_NOTICE_VERSION, REPHRASE_WINDOW_MS, newLearnSink } from './learn-store.js';
import type { LearnSink, LearnStore, SealedEvent } from './learn-store.js';
import type { LearnAction } from './router.js';
import { learnText, leaveText } from '../render/learn.js';
import { LEAVE_DEFAULT_MAX, LEAVE_DEFAULT_MIN } from './repo.js';
import { DEFAULT_TRAVEL_MINUTES } from '../tools/reminders.js';

/** The agent and what it keeps (PLAN §6.19). Absent: the parser answers, as before. */
export type AgentServices = {
  /** In order of preference. A turn runs on one of them. */
  providers: readonly AgentProvider[];
  /**
   * Asked, read-only, when none of `providers` could take the turn and the
   * parser found no tool in the words (2026-10-05).
   */
  fallbackProviders?: readonly AgentProvider[];
  /**
   * The smart conversations' models (`SMART_MODELS`, 2026-10-08), built only
   * when both the Gemini and Groq keys are set. Never part of `providers` or
   * `fallbackProviders`. Asked first on a smart conversation's own words
   * (never shared text, never the read-only try), before `providers`.
   */
  smartProviders?: readonly AgentProvider[];
  budget: TokenBudget;
  history: ConversationHistory;
  lock: AgentLock;
  /** Turns waiting for the phone (§6.21) or for consent. Absent: phone reads are never offered. */
  turns?: SuspendedTurns;
  /**
   * The sources each smart conversation allowed (slice 5, 2026-10-08). Absent,
   * or without `turns`: a smart conversation never asks, and is offered only
   * the tools that never ask (public, private, own-input writes).
   */
  consents?: ConversationConsents;
  /** The turn benchmark's OLD config only (`test/evals/run-turn-evals.ts`). Never set in production. */
  legacyCatalog?: boolean;
  /**
   * The latest local turn's tool groups per conversation (block J, J2a). Absent:
   * a message that names no group always gets the full set, as before.
   */
  selections?: LastSelections;
};

/** The stateful collaborators the Durable Object owns and hands in. */
export type Services = {
  reminders: ReminderStore;
  /** Notes and expenses (§6.22). Absent only in tests that predate them. */
  notes?: NoteStore;
  /** Named lists (§6.25). */
  lists?: ListStore;
  /** Facts about the user (§6.26): the agent sees them on every turn. */
  facts?: FactStore;
  /** The stock portfolio and its quote sources (§6.24). */
  holdings?: HoldingStore;
  quotes?: QuoteSources;
  expenses?: ExpenseStore;
  /** Routines synced from the paired app, and their runs (§6.27). */
  routines?: RoutineStore;
  /** The screen agent's allowlist and tasks (§6.28). */
  screen?: ScreenStore;
  /** Routine drafts the bot builds (docs/plans/routine-builder.md). */
  drafts?: DraftStore;
  /** Wakes the phone about a screen task: an approval decided, or the task stopped. */
  screenPush?: (taskId: string, kind: 'screen_release' | 'screen_stop') => Promise<void>;
  pending: PendingActions;
  /** The one clarifying question a sender may have open (§6.11). */
  questions: OpenQuestions;
  deferred: UndoActions;
  /** The fallback chain, in order. Empty means no parsing is available. */
  nlu: NluProvider[];
  /**
   * The per-model budget the parser spends from (plan K3). Present: the chain is
   * metered once per message, with that message's refused models (§2b).
   */
  tokenBudget?: TokenBudget;
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
  /** Google Contacts' birthdays, once its grant is connected (2026-10-06). */
  contacts?: ContactsClient;
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
  /** A page's readable text, for `web.read` (block J, J3). */
  pageText?: PageText;
  /** Event-triggered reminders (block J, J4). */
  watches?: WatchStore;
  /** Tells the phone its watch list changed (FCM `watches`). */
  watchesChanged?: () => Promise<void>;
  /** Mail follow-ups (block L, L2). */
  followUps?: FollowUpStore;
  /** Calendar suggestions (block L, L3). */
  suggestions?: SuggestionStore;
  /** Mail cleanup's batches (block L, L5). */
  archives?: ArchiveStore;
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
  /** Reads an image (§6.32). Absent: images are not taken. */
  readImage?: (input: ImageInput) => Promise<ImageRead>;
  /** Whether the user was told, once, that images go to Gemini (§6.32). Absent: never told. */
  imageNotice?: { seen(): boolean; mark(): void };
  /** Absent only in the Phase 1 tests, which predate the tool layer. */
  services?: Services;
  /** "לא הבנת" capture (§6.23). Never handed to the agent or a model. */
  exchanges?: ExchangeLog;
  /** The learning journal (block K, K1). Like `exchanges`: the pipeline's only, never the agent's. */
  learn?: LearnStore;
  /** Set by `handleInbound` for the turn it is handling: what the turn tells the journal. */
  learnSink?: LearnSink;
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
      /**
       * This reply is the learning notice of this version (block K, K1). Its
       * delivery — the phone's ack of its row, or WhatsApp's accepted send —
       * is what starts collecting.
       */
      learnNotice?: number;
    }
  /** The agent's turn waits for the phone to read this (§6.21). */
  | { action: 'device_query'; queryId: string; query: PhoneReadInput }
  | {
      action: 'none';
      /**
       * `mode_mismatch`: the message declared the other mode than the one its
       * conversation recorded (smart conversations). Refused before anything ran.
       */
      reason: 'duplicate' | 'mode_mismatch' | 'status' | 'not_implemented' | 'reply_deferred';
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
  const learnSink = newLearnSink();
  const outcome = await route(event, { ...deps, watch, learnSink });
  writeLearnSignals(deps, learnSink);

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

  // The conversation's mode is recorded with the dedupe insert, in its
  // transaction, before the first await (smart conversations). A text, voice
  // or image message declares one (absent: local); a button never does.
  const recorded = repo.recordInbound({
    wamid: event.wamid,
    principal,
    receivedAt: now,
    sentAt: event.sentAtMs,
    kind: event.kind,
    ...('conversationId' in event && event.conversationId !== undefined ? { conversation: event.conversationId } : {}),
    ...(event.kind === 'text' || event.kind === 'audio' || event.kind === 'image' ? { mode: event.mode ?? 'local' } : {}),
  });

  if (recorded.status === 'duplicate') {
    log.info('duplicate_dropped', { wamid: event.wamid });
    return { action: 'none', reason: 'duplicate' };
  }
  if (recorded.status === 'mode_mismatch') {
    // Already marked in the same transaction. No model, no reply text.
    log.info('mode_mismatch', { wamid: event.wamid });
    return { action: 'none', reason: 'mode_mismatch' };
  }
  // From here on the event carries the conversation's recorded mode, which
  // picks the models and tools of its turn (smart conversations).
  if (event.kind !== 'unsupported') event = { ...event, mode: recorded.mode };

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

  if (event.kind === 'image') {
    return handleImage(event, deps, now, stale);
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

  // A consent card's answer, or a `/consents` revoke (slice 5). Deterministic
  // too, and taken before anything awaits.
  const consent = parseConsentButton(event.buttonId);
  if (consent) return consentButton(consent, event, deps, now);

  // A weekly-review proposal (block K, K2): the learning store's own rows.
  const button = parseButtonId(event.buttonId);
  if (button?.kind === 'lp') return learnProposalButton(button, event, deps, now);

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

// -- image --------------------------------------------------------------------

/**
 * An image is shared text, one step earlier (PLAN §6.32). Gemini reads it, in
 * every conversation (the user's decision, 2026-10-14: the Groq key has no
 * vision model), and what it read is quoted under the user's request, as text
 * shared from another app is: forwarded, so tainted, so every write it leads
 * to confirms, and the turn runs on the local models. The image goes no
 * further than this function. The first answer says, once, where it went.
 */
async function handleImage(
  event: Extract<InboundEvent, { kind: 'image' }>,
  deps: PipelineDeps,
  now: number,
  stale: boolean,
): Promise<PipelineOutcome> {
  const { repo, log } = deps;

  if (!deps.readImage) {
    log.info('image_not_configured', { wamid: event.wamid });
    repo.markInboundOutcome(event.wamid, { decision: 'UNSUPPORTED' });
    return { action: 'reply', text: he.imageNotConfigured };
  }

  const readImage = deps.readImage;
  const read = await timed(deps, 'image', () =>
    readImage({ mimeType: event.mimeType, data: event.data }),
  );

  if (read.status !== 'ok') {
    // Nothing usable came back. Never guess at what the image might say (invariant 12).
    log.info('image_rejected', { wamid: event.wamid, status: read.status });
    repo.markInboundOutcome(event.wamid, {
      decision: 'CLARIFY',
      errorCode: `E_IMAGE_${read.status.toUpperCase()}`,
    });
    return { action: 'reply', text: imageReply(read.status) };
  }

  const shared: Extract<InboundEvent, { kind: 'text' }> = {
    kind: 'text',
    wamid: event.wamid,
    from: event.from,
    sentAtMs: event.sentAtMs,
    text: composeImage(event.text, read.text),
    // Someone else's content: tainted, and never the smart model's turn (`smartWanted`).
    forwarded: true,
    ...(event.conversationId !== undefined ? { conversationId: event.conversationId } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.mode !== undefined ? { mode: event.mode } : {}),
  };
  const reply = await respondToText(shared.text, { kind: 'text' }, shared, deps, now, stale);
  if (reply.action !== 'reply' || !deps.imageNotice || deps.imageNotice.seen()) return reply;
  deps.imageNotice.mark();
  return { ...reply, text: `${he.imageNotice}\n\n${reply.text}` };
}

function imageReply(status: Exclude<ImageRead['status'], 'ok'>): string {
  switch (status) {
    case 'unreadable':
      return he.imageUnreadable;
    case 'busy':
      return he.imageBusy;
    case 'quota':
      return he.imageQuota;
    case 'not_configured':
      return he.imageNotConfigured;
    case 'failed':
      return he.imageFailed;
  }
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

  // Someone else's words (a forwarded message, or text shared into the app,
  // 2026-10-06) take none of the deterministic shortcuts below: they must not
  // run a command, confirm what is pending, or answer the open question.
  const foreign = event.forwarded;

  // 1. System commands. Fixed patterns, never the LLM (PLAN §6.4).
  const command = foreign ? null : matchCommand(text);
  if (command) {
    log.info('command', { wamid: event.wamid, intent: command.kind, stale, source: source.kind });
    repo.markInboundOutcome(event.wamid, { intent: command.kind, decision: 'ALLOW' });
    repo.audit({ ts: now, principal, tool: command.kind, tier: 0, decision: 'ALLOW', outcome: 'ok' });
    if (command.kind === 'missed' || command.kind === 'misses') {
      return missCommand(command.kind, event.conversationId ?? '', deps);
    }
    if (command.kind === 'memory' || command.kind === 'forget_memory') {
      return memoryCommand(command.kind, deps);
    }
    if (command.kind === 'watches') return watchesCommand(deps);
    if (command.kind === 'followups') return followUpsCommand(deps);
    if (command.kind === 'unarchive') {
      const archives = deps.services?.archives;
      if (!archives) return { action: 'reply', text: archiveText.restore({ kind: 'none' }, 'he') };
      const outcome = await restoreNewest({ store: archives, gmail: deps.services?.gmail ?? null, principal, nowMs: now });
      repo.audit({ ts: now, principal, tool: 'mail.archive', tier: 2, decision: 'UNARCHIVE', outcome: outcome.kind });
      return { action: 'reply', text: archiveText.restore(outcome, 'he') };
    }
    if (command.kind === 'monthly') {
      if (deps.channel !== 'app') return { action: 'reply', text: personalQuestion('watch_app_only', 'he') };
      if (command.set !== null) repo.setMonthly(command.set);
      return { action: 'reply', text: monthlyText.status(repo.monthlyEnabled(), 'he') };
    }
    if (command.kind === 'suggest') {
      if (deps.channel !== 'app') return { action: 'reply', text: personalQuestion('watch_app_only', 'he') };
      if (command.set !== null) repo.setSuggestions(command.set);
      return { action: 'reply', text: suggestText.status(repo.suggestionsEnabled(), 'he') };
    }
    if (command.kind === 'learn') return learnCommand(command.action, deps);
    if (command.kind === 'leave') return leaveCommand(command.set, deps);
    if (command.kind === 'consents') return consentsCommand(event, deps);
    return {
      action: 'reply',
      text: await renderCommand(command, deps, now),
      ...(command.kind === 'connect_google' ? { keepLinks: true } : {}),
    };
  }

  // A message that is not a command counts toward the week (block K, K1).
  deps.learn?.bumpWeek(principal, 'messages');

  if (!deps.services) {
    log.info('nlu_not_configured', { wamid: event.wamid, stale });
    repo.markInboundOutcome(event.wamid, { decision: 'NOT_IMPLEMENTED' });
    return { action: 'reply', text: he.notUnderstood };
  }

  // 2a. A plain "כן" or "אישור" answering a pending question. Also never the LLM: a
  //    confirmation that could be re-parsed is not a confirmation (§6.5).
  const plain = foreign ? null : deps.services.pending.resolvePlainText(text, principal);
  if (plain?.ok) {
    const reply = await runPlainConfirmation(plain.id, turnOf(deps, event, now, source, 'he'));
    repo.markInboundOutcome(event.wamid, { decision: 'CONFIRMED' });
    return asOutcome(reply);
  }
  if (plain && !plain.ok && plain.reason === 'ambiguous') {
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY' });
    return { action: 'reply', text: statusText.confirmAmbiguous };
  }

  // 2b. An answer to the one open question (PLAN §6.11). Before the parser,
  //     because "8" means nothing to a parser and everything to a question —
  //     and because answering costs no tokens at all.
  const open = foreign ? null : deps.services.questions.peek(principal);
  if (open) {
    const answered = await answerOpenQuestion(open, text, source, event, deps, now);
    if (answered) return answered;
    // Not about the question. The user moved on, so the question goes and the
    // message is read from the top as a request of its own.
    deps.services.questions.clear(principal);
    log.info('question_abandoned', { tool: open.tool, asked: open.asked });
  }

  // 2c. The screen agent is at work (§6.28): a code reply with its stop button,
  //     no model — a second turn would race it for the phone and the lock.
  const screenTask = deps.services.screen?.active(principal);
  if (screenTask && screenTask.status !== 'confirmed') {
    repo.markInboundOutcome(event.wamid, { decision: 'BUSY' });
    return {
      action: 'reply',
      text: screenText.busy(screenTask.appLabel, 'he'),
      buttons: [{ id: buttonId('ss', screenTask.taskId, screenTask.stopNonce, 'no'), title: screenText.stopButton('he') }],
    };
  }

  // 3. The models. Only here does a turn write the latest exchange that
  //    "לא הבנת" keeps (§6.23): commands, confirmations and answers above never
  //    do, so "לא הבנת" after a "כן" still finds the request it answered.
  const answered = await respondWithModels(text, source, event, deps, now, deps.services);
  // "לא הבנתי" alone tells the user nothing to try: two phrasings that work.
  const outcome: PipelineOutcome =
    answered.action === 'reply' && answered.text === he.notUnderstood
      ? { ...answered, text: `${answered.text}\n\n${examplesFor(matchGroups(text))}` }
      : answered;
  if (!BUSY_REPLIES.has(outcome) && outcome.action === 'reply') {
    await keepExchange(deps, event.wamid, event.conversationId ?? '', source.kind === 'voice' ? he.voicePlaceholder : text, text, outcome, {
      // Typed words of the user's own only: a voice note or shared text is never a rephrase.
      rephrase: source.kind === 'text' && !event.forwarded,
    });
  }
  // A smart conversation answered without its smart model, because none is
  // configured, says so on the first line (2026-10-08). Shared text is local
  // in any smart conversation, so it says nothing.
  if (outcome.action === 'reply' && smartWanted(event) && !deps.services.agent?.smartProviders?.length) {
    const note = he.smartUnavailable(languageOf(text));
    return {
      ...outcome,
      text: `${note}\n\n${outcome.text}`,
      ...(outcome.withoutEcho !== undefined ? { withoutEcho: `${note}\n\n${outcome.withoutEcho}` } : {}),
    };
  }
  return outcome;
}

/**
 * The message is a smart conversation's own words (2026-10-08): the recorded
 * mode is smart, and it is not someone else's text shared into it.
 */
function smartWanted(event: Extract<InboundEvent, { kind: 'text' | 'audio' }>): boolean {
  return event.mode === 'smart' && !event.forwarded;
}

/** Steps 3 on of `respondToText`: the agent, the parser, the read-only try. */
async function respondWithModels(
  text: string,
  source: TextSource,
  event: Extract<InboundEvent, { kind: 'text' | 'audio' }>,
  deps: PipelineDeps,
  now: number,
  services: Services,
): Promise<PipelineOutcome> {
  const { repo, log } = deps;
  const foreign = event.forwarded;

  // 3. The agent (§6.19). It falls back to the parser below only when nothing
  //    ran — a fallback after a tool had run would run the message twice.
  //    One scope for the whole message: a model that refused it for rate or
  //    budget is not asked again by the agent, the parser, or the read-only try.
  const scope = newMessageScope();
  let agentFailure: string | null = null;
  if (services.agent) {
    const answered = await respondWithAgent(services.agent, text, source, event, deps, now, { scope });
    if ('fellBack' in answered) agentFailure = answered.fellBack;
    else return answered;
  }

  // The turn ran out of time (Improvement plan §3 T3): no parser, no read-only
  // try — nothing past the deadline may reach a model or act.
  if (agentFailure === 'deadline') {
    repo.markInboundOutcome(event.wamid, { decision: 'CLARIFY', errorCode: 'E_AGENT_DEADLINE' });
    return { action: 'reply', text: he.agentFailed(agentFailure) };
  }

  // 3b. The LLM as a parser: the path before the agent, and its fallback.
  const nlu = services.tokenBudget
    ? meterParsers(services.nlu, services.tokenBudget, scope)
    : services.nlu;
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
    const agent = services.agent;
    if (agent?.fallbackProviders?.length && !TURN_SHAPE_FAILURES.has(agentFailure)) {
      const answered = await respondWithAgent(agent, text, source, event, deps, now, { readOnly: true, scope });
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
    runIntent(checked.draft, turnOf(deps, event, now, source, lang, text), {
      dayInDoubt: checked.mismatched,
    }),
  );
  repo.markInboundOutcome(event.wamid, { intent: checked.draft.intent, decision: 'ALLOW' });
  // A tainted turn's answer stays off the lock screen, as on the agent path,
  // and a question it asks is answered under the same taint.
  if (foreign) {
    const question = reply.question ? { ...reply.question, tainted: true } : undefined;
    return { ...replyOutcome({ ...reply, ...(question ? { question } : {}) }, deps), private: true } as PipelineOutcome;
  }
  return replyOutcome(reply, deps);
}

/** The `agentBusy` reply: no model ran, so it is not an exchange (§6.23). */
const BUSY_REPLIES = new WeakSet<PipelineOutcome>();

/**
 * Keep this turn as the conversation's latest exchange (§6.23). Never throws
 * and never logs content: a failure here must not cost the user their answer.
 */
async function keepExchange(
  deps: PipelineDeps,
  wamid: string,
  conversation: string,
  /** What the user's side keeps: the words, or the voice placeholder. */
  userText: string,
  /** The words themselves, for the tool groups only. */
  words: string,
  outcome: Extract<PipelineOutcome, { action: 'reply' }>,
  /** May this turn be the rephrase of the one before it (block K, K1)? */
  options: { rephrase: boolean } = { rephrase: false },
): Promise<void> {
  const exchanges = deps.exchanges;
  if (!exchanges) return;
  try {
    const seq = deps.repo.inboundSeq(wamid);
    if (seq === null) return;
    const row = deps.repo.getInbound(wamid);
    const decision = typeof row?.['decision'] === 'string' ? row['decision'] : 'NONE';
    const errorCode = typeof row?.['error_code'] === 'string' ? row['error_code'] : null;
    const intent = typeof row?.['intent'] === 'string' ? row['intent'] : null;
    // A private reply (notes) or someone else's words keep placeholders only.
    const kept = outcome.private === true;
    const exchange: Exchange = {
      user: kept ? he.privatePlaceholder : userText,
      reply: kept ? he.privatePlaceholder : (outcome.withoutEcho ?? outcome.text),
      outcome: errorCode ? `${decision}/${errorCode}` : decision,
      intent,
      groups: matchGroups(words),
      at: deps.now(),
      understood: deps.learnSink?.understood ?? false,
    };

    // Read the previous exchange before this one replaces it: was this turn
    // the rephrase of a request that failed a moment ago?
    const pair = options.rephrase && !kept ? await rephrasePair(deps, exchanges, conversation, seq, exchange) : null;
    const sealed = await exchanges.seal(deps.principal, conversation, exchange);
    // One synchronous step: the pair only when nothing newer landed while
    // this one was encrypting, so the pair is the two turns it names.
    deps.repo.transaction(() => {
      const before = exchanges.currentSeq(deps.principal, conversation);
      exchanges.writeSealed(deps.principal, conversation, seq, sealed);
      if (pair && deps.learn && before === pair.prevSeq) {
        deps.learn.insertSealed(pair.event);
        deps.learn.bumpWeek(deps.principal, 'rephrases');
      }
    });
  } catch {
    deps.log.warn('exchange_keep_failed', { wamid });
  }
}

/**
 * The previous exchange failed (no tool ran, no card was shown), was the
 * user's own typed words, is under three minutes old, and this turn — also the
 * user's own words — was understood: one heuristic `rephrase` row holding both
 * (block K, K1). The placeholders `keepExchange` writes are the exclusions.
 */
async function rephrasePair(
  deps: PipelineDeps,
  exchanges: ExchangeLog,
  conversation: string,
  seq: number,
  current: Exchange,
): Promise<{ prevSeq: number; event: SealedEvent } | null> {
  const learn = deps.learn;
  const sink = deps.learnSink;
  if (!learn || !sink || !current.understood || !learn.collectable('rephrase')) return null;
  if (sink.tools.includes('screen.task')) return null;
  const previous = await exchanges.latest(deps.principal, conversation);
  if (!previous || previous.seq >= seq) return null;
  const prev = previous.exchange;
  if (prev.understood !== false) return null;
  if (current.at < prev.at || current.at - prev.at >= REPHRASE_WINDOW_MS) return null;
  if (PLACEHOLDERS.has(prev.user) || PLACEHOLDERS.has(prev.reply)) return null;
  const start = learn.startOf('rephrase');
  if (start === null || prev.at < start) return null;
  const event = await learn.sealRephrase(
    deps.principal,
    { user: prev.user, reply: prev.reply, outcome: prev.outcome, intent: prev.intent },
    { user: current.user, reply: current.reply, outcome: current.outcome, intent: current.intent },
    { gapSeconds: (current.at - prev.at) / 1000, tools: sink.tools },
  );
  return event ? { prevSeq: previous.seq, event } : null;
}

/** What `keepExchange` stores instead of words that are not the user's own typed text. */
const PLACEHOLDERS: ReadonlySet<string> = new Set([he.privatePlaceholder, he.voicePlaceholder]);

/**
 * Write what the turn told the journal (block K, K1): an Undo, a declined
 * confirmation, a "time to leave" that was set. Tool names and numbers only.
 * Never throws: the journal is never worth the user's answer.
 */
function writeLearnSignals(deps: PipelineDeps, sink: LearnSink): void {
  const learn = deps.learn;
  if (!learn || sink.signals.length === 0) return;
  try {
    const now = deps.now();
    for (const signal of sink.signals) {
      if (signal.kind === 'executed') {
        if (signal.tool !== 'reminders.leave') continue;
        const input = signal.input as { minutes?: unknown; stated?: unknown } | null;
        // Older rows carry no `stated`: they teach nothing.
        if (typeof input?.minutes === 'number' && typeof input.stated === 'boolean') {
          learn.addLeave(deps.principal, input.minutes, input.stated);
        }
      } else if (!(signal.kind === 'confirm_no' && signal.tool === 'memory.remember')) {
        // A fact offered and declined is not an action the user asked for and refused.
        learn.addTap(deps.principal, signal.kind, signal.tool, (now - signal.createdAt) / 1000);
      }
    }
  } catch {
    deps.log.warn('learn_signal_failed', {});
  }
}

/** `/learn`, `/learn on|off|forget` (block K, K1). Code only; nothing here reaches a model. */
function learnCommand(action: LearnAction, deps: PipelineDeps): PipelineOutcome {
  const learn = deps.learn;
  if (!learn) return { action: 'reply', text: learnText.unavailable };
  switch (action) {
    case 'status':
      return { action: 'reply', text: learnText.status(learn.status(deps.principal)) };
    case 'on': {
      const before = learn.state();
      if (learn.turnOn() === 'already') return { action: 'reply', text: learnText.alreadyOn };
      // Re-sent while it was on: a stale version, or one still waiting for the phone.
      return {
        action: 'reply',
        text: learnText.notice(before.seen, before.on),
        learnNotice: LEARN_NOTICE_VERSION,
      };
    }
    case 'off':
      return { action: 'reply', text: learn.turnOff() ? learnText.off : learnText.alreadyOff };
    case 'forget':
      return { action: 'reply', text: learnText.forgotten(learn.forget(deps.principal)) };
    case 'export':
      return { action: 'reply', text: learnText.exportWhere };
  }
}

/** `/leave`, `/leave N`, `/leave off` (block K, K2): the setter a `leave_min` proposal shares. */
function leaveCommand(set: Extract<Command, { kind: 'leave' }>['set'], deps: PipelineDeps): PipelineOutcome {
  const { repo } = deps;
  if (set === 'invalid') return { action: 'reply', text: leaveText.invalid(LEAVE_DEFAULT_MIN, LEAVE_DEFAULT_MAX) };
  if (set === 'off') {
    repo.setLeaveDefaultMinutes(null);
    return { action: 'reply', text: leaveText.reset(DEFAULT_TRAVEL_MINUTES) };
  }
  if (set === null) {
    const stored = repo.leaveDefaultMinutes();
    return { action: 'reply', text: leaveText.current(stored ?? DEFAULT_TRAVEL_MINUTES, stored === null) };
  }
  repo.setLeaveDefaultMinutes(set);
  return { action: 'reply', text: leaveText.set(set) };
}

/**
 * A weekly-review button (`lp:`, block K, K2). Deterministic, before any
 * await, and in the pipeline: the learning store is never on a tool's or the
 * agent's context. The reply is the row's status after the transaction.
 */
function learnProposalButton(
  parsed: { id: string; nonce: string; verb: string },
  event: Extract<InboundEvent, { kind: 'button' }>,
  deps: PipelineDeps,
  now: number,
): PipelineOutcome {
  const { repo, principal } = deps;
  repo.markInboundOutcome(event.wamid, { decision: 'BUTTON' });
  if (!deps.learn || (parsed.verb !== 'ok' && parsed.verb !== 'no')) return { action: 'reply', text: learnText.expired };
  const answer = deps.learn.answerProposal(principal, parsed.id, parsed.nonce, parsed.verb === 'ok');
  repo.audit({ ts: now, principal, tool: 'learn.proposal', tier: 0, decision: 'BUTTON', outcome: answer.kind });
  switch (answer.kind) {
    case 'applied':
      return { action: 'reply', text: learnText.applied(answer.proposal, answer.value) };
    case 'declined':
      return { action: 'reply', text: learnText.declined };
    case 'answered':
      return { action: 'reply', text: learnText.answered };
    case 'expired':
    case 'gone':
      return { action: 'reply', text: learnText.expired };
  }
}

/** `/memory` and `/forget memory` (§6.26). Private: the user's own words. */
async function memoryCommand(kind: 'memory' | 'forget_memory', deps: PipelineDeps): Promise<PipelineOutcome> {
  const facts = deps.services?.facts;
  if (!facts) return { action: 'reply', text: personalQuestion('no_facts', 'he'), private: true };
  if (kind === 'forget_memory') {
    const removed = facts.wipe(deps.principal);
    return { action: 'reply', text: removed > 0 ? factText.forgotten('he') : personalQuestion('no_facts', 'he'), private: true };
  }
  const all = await facts.all(deps.principal);
  const notes = deps.services?.notes?.all(deps.principal).length ?? 0;
  return { action: 'reply', text: factText.all(all.map((fact) => fact.text), notes, 'he'), private: true };
}

/** "לא הבנת" and `/misses` (§6.23). Private: they show the user's own words. */
async function missCommand(
  kind: 'missed' | 'misses',
  conversation: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const exchanges = deps.exchanges;
  if (!exchanges) return { action: 'reply', text: missText.none, private: true };
  if (kind === 'misses') {
    const misses = await exchanges.list(deps.principal);
    return { action: 'reply', text: misses.length === 0 ? missText.empty : missText.list(misses), private: true };
  }
  if (deps.services?.agent?.lock.isHeld(deps.principal)) {
    return { action: 'reply', text: missText.stillRunning, private: true };
  }
  const captured = await exchanges.capture(deps.principal, conversation);
  if (captured.kind === 'saved') await copyMissToJournal(deps, captured.exchange);
  return {
    action: 'reply',
    text: captured.kind === 'saved' ? missText.saved(captured.exchange.user) : missText.none,
    private: true,
  };
}

/** A kept miss, copied into the journal with its own ciphertext (block K, K1). */
async function copyMissToJournal(deps: PipelineDeps, exchange: Exchange): Promise<void> {
  const learn = deps.learn;
  if (!learn) return;
  try {
    const start = learn.startOf('miss');
    if (start === null || exchange.at < start) return;
    const sealed = await learn.sealMiss(deps.principal, exchange);
    if (!sealed) return;
    deps.repo.transaction(() => {
      learn.insertSealed(sealed);
      learn.bumpWeek(deps.principal, 'misses');
    });
  } catch {
    deps.log.warn('learn_miss_failed', {});
  }
}

/** Failures of the turn itself, not of the model: another model would hit them too. */
const TURN_SHAPE_FAILURES: ReadonlySet<string> = new Set(['turn_token_cap', 'max_calls', 'deadline']);

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
  /** The fallback model's read-only second try (2026-10-05), and the message's scope (§2b). */
  options: { readOnly?: boolean; scope?: MessageScope } = {},
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
    // No model ran: the turn still running writes its own exchange (§6.23).
    const busy: PipelineOutcome = { action: 'reply', text: he.agentBusy };
    BUSY_REPLIES.add(busy);
    return busy;
  }

  // A turn left waiting for the phone is not going to be continued now: this
  // newer message is what the user is talking about (§6.21).
  if (!readOnly) agent.turns?.supersede(principal);

  try {
    const lang = languageOf(text);
    // Each of the app's conversations keeps its own memory (2026-10-01).
    const conversation = event.conversationId ?? '';
    // The conversation's recorded mode (2026-10-08). Its own words may go to a
    // smart model first; shared text and the read-only try stay local. Every
    // model in it is offered the same tools and sees no facts.
    const smartConversation = event.mode === 'smart';
    const smartModels = smartWanted(event) && !readOnly ? (agent.smartProviders ?? []) : [];
    // Facts about the user (§6.26): the agent's own read; never the misses or
    // notes, and never in a smart conversation.
    const facts =
      deps.services?.facts && !smartConversation ? (await deps.services.facts.all(principal)).map((fact) => fact.text) : [];
    // Consent (slice 5): the sources this smart conversation allowed are
    // offered to every model in it. Only its own typed words may ask for
    // another — never a voice note (the turn would store a transcript), the
    // read-only try, or someone else's text.
    const consents = agent.consents;
    const granted = smartConversation && consents ? consents.list(principal, conversation) : [];
    // The history, by what the conversation allows now (2026-10-12): after a
    // revoke, a reply that carried the source — or one written before replies
    // were tagged — is replayed as the placeholder. A local one replays as is.
    const stored = await agent.history.recent(principal, conversation);
    const { entries: history, sources: historySources } = smartConversation
      ? replayByConsent(stored, granted, he.withheldPlaceholder)
      : { entries: stored, sources: provenanceOf(stored) };
    // A short follow-up that names no group inherits the previous local turn's
    // groups (block J, J2a). Local conversations' new messages only: never the
    // read-only try, never a smart conversation, never a resume.
    const selections = !smartConversation && !readOnly ? agent.selections : undefined;
    const inheritedGroups = selections && mayInherit(text) ? selections.inherited(principal, conversation) : null;
    const ask =
      smartConversation &&
      !readOnly &&
      source.kind === 'text' &&
      !event.forwarded &&
      conversation !== '' &&
      agent.turns !== undefined &&
      consents !== undefined;
    const result = await timed(deps, 'agent', () =>
      runAgentTurn(
        {
          text,
          lang,
          nowMs: now,
          turn: turnOf(deps, event, now, source, lang, text),
          history,
          ...(facts.length > 0 ? { facts } : {}),
          // Phone actions only where an app that runs cards will receive them (§6.20).
          cards: deps.channel === 'app' && (deps.deviceCaps ?? []).includes('cards'),
          fileCards: deps.channel === 'app' && (deps.deviceCaps ?? []).includes('file'),
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
          ...(smartConversation ? { smart: true, consent: { granted, ask }, historySources } : {}),
          ...(inheritedGroups ? { inheritedGroups } : {}),
          // Only when the words hold exactly one https link (block J, J3).
          ...(singleHttpsUrl(text) !== null ? { webRead: true } : {}),
          // Only in the app, and only when the words say "when … arrives" (block J, J4).
          ...(deps.channel === 'app' && deps.services?.watches && namesWatch(text) ? { watch: true } : {}),
          // Only in the app, and only when the words say "if they don't reply" (block L, L2).
          ...(deps.channel === 'app' && deps.services?.followUps && namesFollowUp(text) ? { followUp: true } : {}),
          // Only when the words ask for the monthly bookkeeping file (block L, L4).
          ...(namesMonthlyPack(text) ? { monthly: true } : {}),
          // Only when the words say "archive" (block L, L5).
          ...(deps.services?.archives && namesArchive(text) ? { archive: true } : {}),
          // Only when the words ask for a document (block L, L6).
          ...(namesDocument(text) ? { document: true } : {}),
          // Only when the words name a synced routine (§6.27, decision D4).
          ...(deps.channel === 'app' && namesRoutine(text, deps.services?.routines, principal) ? { routines: true } : {}),
          // Only when the words name the screen agent or an app on its list (§6.28).
          ...(deps.channel === 'app' && deps.services?.screen && namesScreenTask(text, deps.services.screen.allowed(principal))
            ? { screen: true }
            : {}),
          // Only in the app, when the words ask to build a routine and the app can (docs/plans/routine-builder.md).
          ...(deps.channel === 'app' && deps.services?.drafts && namesRoutineBuild(text)
            ? { routineBuild: true, routineDraftCap: (deps.deviceCaps ?? []).includes('routine_draft') }
            : {}),
        },
        {
          providers: readOnly ? (agent.fallbackProviders ?? []) : [...smartModels, ...agent.providers],
          budget: agent.budget,
          log,
          now: deps.now,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(agent.legacyCatalog ? { legacyCatalog: true } : {}),
          ...(selections
            ? {
                onLocalSelection: (groups: readonly GroupName[], tainted: boolean) => {
                  const seq = repo.inboundSeq(event.wamid);
                  if (seq !== null) selections.record(principal, conversation, seq, groups, tainted);
                },
              }
            : {}),
        },
      ),
    );

    if (result.kind === 'suspend' && agent.turns) {
      const stored = {
        ...result.state,
        ...(conversation === '' ? {} : { conversation }),
        ...(event.forwarded ? { foreign: true } : {}),
      };
      if (stored.kind === 'consent') {
        // The card is this message's answer; the tap's answer is the turn's
        // (slice 5). Nothing was read, so the card is not private.
        const { queryId, nonce } = await agent.turns.suspendForConsent(principal, event.wamid, stored);
        repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'CONSENT' });
        log.info('agent_consent_asked', { wamid: event.wamid, tool: stored.tool, source: stored.source });
        return {
          action: 'reply',
          text: consentText.card(stored.source, stored.lang),
          buttons: consentButtons(queryId, nonce, stored.source, stored.lang),
        };
      }
      const queryId = await agent.turns.suspend(principal, event.wamid, stored);
      repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'DEVICE_QUERY' });
      log.info('agent_suspended', { wamid: event.wamid, tool: stored.tool });
      return { action: 'device_query', queryId, query: stored.query };
    }

    const settled = await settleAgentResult(
      result,
      source.kind === 'voice' ? he.voicePlaceholder : text,
      event.wamid,
      deps,
      now,
      conversation,
      { smart: smartConversation, foreign: event.forwarded, historySources },
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
  /**
   * A smart conversation's turn, whether its words were someone else's
   * (2026-10-08), and the sources of the history the model saw in full
   * (2026-10-12), which its reply may repeat.
   */
  gate: { smart: boolean; foreign: boolean; historySources: readonly ConsentSource[] },
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

  // J2a: the turn that chose these groups ran tools from them; a follow-up may
  // inherit them. Only that very turn (`seq =`), never the read-only try.
  if (!secondTry && result.tools && result.tools.length > 0) {
    const seq = agent?.selections ? repo.inboundSeq(wamid) : null;
    if (seq !== null) agent?.selections?.markRan(principal, conversation, seq, result.tools);
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
    // A private tool's exchange (notes) is remembered as a placeholder only:
    // neither the words that saved a note nor a reply showing one reach the
    // model on a later turn (2026-10-05).
    const kept = outcome.private === true;
    // A smart conversation's history may reach a model that trains on it
    // (2026-10-08). It keeps placeholders for someone else's words, both sides,
    // and for any reply after a tool whose data the user did not allow — a
    // card, an Undo, a list of choices built by code included. Allowed: public,
    // or a source the conversation allowed, or one approved for this very turn
    // (its entry only; the next turn asks again), or a write whose replies only
    // echo its own call (2026-10-11, `echoesOwnInput`). Private never is.
    const shared = gate.smart && gate.foreign;
    const consents = agent.consents;
    const granted = gate.smart && consents ? consents.list(principal, conversation) : [];
    const allowed = new Set<ConsentSource>([...granted, ...(result.once ?? [])]);
    const ran = result.tools ?? [];
    const withheld =
      gate.smart &&
      ran.some((tool) => {
        const data = dataSourceOf(tool);
        if (data === 'public' || echoesOwnInput(tool)) return false;
        return !(isConsentSource(data) && allowed.has(data));
      });
    // A source allowed for the conversation was used: its row stays clear of the purge.
    if (gate.smart && consents && conversation !== '') {
      const used = ran.map(consentSourceOf).filter((data): data is ConsentSource => data !== null && granted.includes(data));
      if (used.length > 0) consents.touch(principal, conversation, used);
    }
    // Where the kept reply's data may come from (2026-10-12): this turn's
    // consent-source tools, own-input writes aside, and the history it saw.
    // A placeholder carries nothing. Replayed only while all are allowed.
    const placeholder = kept || shared || withheld;
    const src = placeholder
      ? []
      : [
          ...new Set([
            ...gate.historySources,
            ...ran.filter((tool) => !echoesOwnInput(tool)).flatMap((tool) => consentSourceOf(tool) ?? []),
          ]),
        ];
    await agent.history.append(
      principal,
      {
        // A transcript is never stored (invariant 13); the reply carries the context.
        user: kept ? he.privatePlaceholder : shared ? he.sharedPlaceholder : userText,
        reply: kept
          ? he.privatePlaceholder
          : shared
            ? he.sharedPlaceholder
            : withheld
              ? he.withheldPlaceholder
              : outcome.text,
        tainted: result.tainted,
        src,
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
/** A turn the phone's read resumed (§6.21), with its own learning sink (block K, K1). */
export async function resumeFromPhone(
  request: Parameters<typeof resumeTurn>[0],
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const learnSink = newLearnSink();
  const outcome = await resumeTurn(request, { ...deps, learnSink });
  writeLearnSignals(deps, learnSink);
  return outcome;
}

async function resumeTurn(
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
    const turn = turnOf(deps, { sentAtMs: request.sentAtMs, forwarded: false, ...(state.mode ? { mode: state.mode } : {}) }, now, { kind: 'text' }, state.lang);
    // The stored mode picks the providers (2026-10-08): a smart conversation's
    // turn may have started on its smart model.
    const smart = state.mode === 'smart';
    const providers = smart ? [...(agent.smartProviders ?? []), ...agent.providers] : agent.providers;
    // What the conversation allows now (slice 5): a resumed turn asks no one.
    const granted = smart && agent.consents ? agent.consents.list(principal, state.conversation ?? '') : [];
    const result = await timed(deps, 'agent', () =>
      resumeAgentTurn(state, request.result, turn, { providers, budget: agent.budget, log, now: deps.now }, granted),
    );
    log.info('agent_resumed', { wamid: request.wamid, readStatus: request.result.status, itemCount: request.result.items.length });

    const settled = await settleAgentResult(result, state.text, request.wamid, deps, now, state.conversation ?? '', {
      smart,
      foreign: state.foreign === true,
      historySources: state.historySources ?? [],
    });
    // No fallback here: the parser never sees a turn the phone has answered.
    const outcome: PipelineOutcome = settled ?? { action: 'reply', text: he.agentIncomplete };
    // Kept under the original message's place in line, so a late resume never
    // overwrites a newer exchange (§6.23).
    if (outcome.action === 'reply') {
      await keepExchange(deps, request.wamid, state.conversation ?? '', state.text, state.text, outcome);
    }
    return outcome;
  } finally {
    turns.finish(request.queryId);
    agent.lock.release(principal, request.wamid);
  }
}

// -- consent (smart conversations, slice 5) ----------------------------------

/** A consent card's answer or a `/consents` revoke: code only, never a model (invariant 7). */
function consentButton(
  button: ConsentButton,
  event: Extract<InboundEvent, { kind: 'button' }>,
  deps: PipelineDeps,
  now: number,
): Promise<PipelineOutcome> | PipelineOutcome {
  return button.kind === 'answer' ? consentAnswer(button, event, deps, now) : consentRevoke(button, event, deps);
}

/**
 * A tap on a consent card. Before anything awaits, in one transaction: take
 * the waiting turn once (`beginConsent`: a consent turn, this sender, the
 * nonce, a choice its source offers, still waiting, not expired), take the
 * agent lock, and for "this conversation" write the consent — so a tap that
 * loses any of these runs nothing and grants nothing. Then the turn goes on
 * from its stored call, on the same model (`resumeAfterConsent`); a phone read
 * it allowed pauses it again, under the tap. Every refusal says the same:
 * expired, ask again — never which gate it was.
 */
async function consentAnswer(
  button: Extract<ConsentButton, { kind: 'answer' }>,
  event: Extract<InboundEvent, { kind: 'button' }>,
  deps: PipelineDeps,
  now: number,
): Promise<PipelineOutcome> {
  const { repo, log, principal } = deps;
  const agent = deps.services?.agent;
  const turns = agent?.turns;
  const consents = agent?.consents;
  const refuse = (reason: string): PipelineOutcome => {
    log.info('agent_consent_stale', { wamid: event.wamid, reason });
    repo.markInboundOutcome(event.wamid, { intent: 'consent', decision: 'BUTTON', errorCode: 'E_CONSENT_STALE' });
    return { action: 'reply', text: consentText.expired('he') };
  };
  if (!agent || !turns || !consents) return refuse('unavailable');

  const persist = button.verb === 'conv';
  const claimed = repo.transaction(() => {
    const begun = turns.beginConsent(button.queryId, principal, button.nonce, persist);
    if (begun.kind !== 'run') return begun;
    // A newer turn holds the lock: this one is cancelled, never interleaved.
    if (!agent.lock.acquire(principal, begun.wamid)) {
      turns.finish(button.queryId, 'superseded');
      return { kind: 'busy' as const };
    }
    if (persist) consents.grant(principal, begun.conversation, begun.source);
    return begun;
  });
  if (claimed.kind !== 'run') return refuse(claimed.kind === 'settled' ? claimed.status : claimed.kind);

  try {
    const state = await turns.open(button.queryId, principal, claimed.ciphertext);
    // The row's source (checked before the tap was taken) is the stored turn's own.
    if (!state || state.kind !== 'consent' || state.source !== claimed.source) {
      log.warn('agent_resume_unreadable', { wamid: event.wamid });
      repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'ERROR', errorCode: 'E_AGENT_STATE' });
      return { action: 'reply', text: he.agentIncomplete };
    }

    const decision: ConsentDecision = button.verb === 'no' ? 'declined' : persist ? 'conversation' : 'once';
    log.info('agent_consent_answered', { wamid: event.wamid, tool: state.tool, source: state.source, decision });
    const conversation = state.conversation ?? claimed.conversation;
    // The asking message's signed time, for the staleness rule, as after a phone read.
    const sentAtMs = Number(repo.getInbound(claimed.wamid)?.['sent_at'] ?? now);
    // A consent card is asked only in a smart conversation.
    const turn = turnOf(deps, { sentAtMs, forwarded: false, mode: 'smart' }, now, { kind: 'text' }, state.lang);
    const providers = [...(agent.smartProviders ?? []), ...agent.providers];
    const result = await timed(deps, 'agent', () =>
      resumeAfterConsent(state, decision, consents.list(principal, conversation), turn, { providers, budget: agent.budget, log, now: deps.now }),
    );

    if (result.kind === 'suspend') {
      if (result.state.kind === 'consent') {
        // The loop never asks twice; reaching here is a bug.
        repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'ALLOW', errorCode: 'E_AGENT_PARTIAL' });
        return { action: 'reply', text: he.agentIncomplete };
      }
      // The allowed call is a phone read: the turn's second pause, under the tap.
      const queryId = await turns.suspend(principal, event.wamid, {
        ...result.state,
        conversation,
        ...(state.foreign ? { foreign: true } : {}),
      });
      repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'DEVICE_QUERY' });
      log.info('agent_suspended', { wamid: event.wamid, tool: result.state.tool });
      return { action: 'device_query', queryId, query: result.state.query };
    }

    const settled = await settleAgentResult(result, state.text, event.wamid, deps, now, conversation, {
      smart: true,
      foreign: state.foreign === true,
      historySources: state.historySources ?? [],
    });
    // No fallback: the parser never sees a turn the user has answered a card on.
    if (!settled) repo.markInboundOutcome(event.wamid, { intent: 'agent', decision: 'ALLOW', errorCode: 'E_AGENT_PARTIAL' });
    const outcome: PipelineOutcome = settled ?? {
      action: 'reply',
      text: decision === 'declined' ? consentText.declined(state.source, state.lang) : he.agentIncomplete,
    };
    // Kept under the asking message's place in line, as after a phone read (§6.23).
    if (outcome.action === 'reply') await keepExchange(deps, claimed.wamid, conversation, state.text, state.text, outcome);
    return outcome;
  } finally {
    turns.finish(button.queryId);
    agent.lock.release(principal, claimed.wamid);
  }
}

/** A `/consents` revoke button: a one-shot offer, sender- and nonce-checked (`confirm/undo.ts`). */
function consentRevoke(
  button: Extract<ConsentButton, { kind: 'revoke' }>,
  event: Extract<InboundEvent, { kind: 'button' }>,
  deps: PipelineDeps,
): PipelineOutcome {
  const { repo, log, principal } = deps;
  const consents = deps.services?.agent?.consents;
  const used = deps.services?.deferred.use(button.id, button.nonce, principal);
  repo.markInboundOutcome(event.wamid, { intent: 'consents', decision: 'BUTTON' });
  const target = used?.ok && used.tool === CONSENT_REVOKE_TOOL ? revokeTarget(used.compensating) : null;
  if (!consents || !target) {
    log.info('consent_revoke_refused', { wamid: event.wamid });
    return { action: 'reply', text: consentText.revokeExpired('he') };
  }
  consents.revoke(principal, target.conversation, target.source);
  log.info('consent_revoked', { wamid: event.wamid, source: target.source });
  return { action: 'reply', text: consentText.revoked(target.source, 'he') };
}

function revokeTarget(value: unknown): { conversation: string; source: ConsentSource } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { conversation, source } = value as Record<string, unknown>;
  return typeof conversation === 'string' && conversation !== '' && isConsentSource(source) ? { conversation, source } : null;
}

/**
 * `/consents` (slice 5): in a smart conversation, the sources it allowed, each
 * with a button that revokes it. Deterministic; no model.
 */
function consentsCommand(event: Extract<InboundEvent, { kind: 'text' | 'audio' }>, deps: PipelineDeps): PipelineOutcome {
  const conversation = event.conversationId ?? '';
  const consents = deps.services?.agent?.consents;
  const deferred = deps.services?.deferred;
  if (event.mode !== 'smart' || conversation === '' || !consents || !deferred) {
    return { action: 'reply', text: consentText.onlySmart('he') };
  }
  const granted = consents.list(deps.principal, conversation);
  if (granted.length === 0) return { action: 'reply', text: consentText.none('he') };
  const buttons = granted.map((source) => {
    const offer = deferred.offer({ tool: CONSENT_REVOKE_TOOL, compensating: { conversation, source }, principal: deps.principal });
    return { id: revokeButtonId(offer.id, offer.nonce), title: consentText.revokeButton(source, 'he') };
  });
  return { action: 'reply', text: consentText.list(granted, 'he'), buttons };
}

/** How long a `/watches` cancel button stays usable. */
const WATCH_CANCEL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * `/watches` (block J, J4): the active event-triggered reminders, each with a
 * cancel button — a one-shot Undo offer of `reminders.when`, so the tap goes
 * through the same nonce, sender and expiry gates as any Undo. No model.
 */
function watchesCommand(deps: PipelineDeps): PipelineOutcome {
  const watches = deps.services?.watches;
  const deferred = deps.services?.deferred;
  if (deps.channel !== 'app' || !watches || !deferred) {
    return { action: 'reply', text: personalQuestion('watch_app_only', 'he') };
  }
  const active = watches.active(deps.principal);
  if (active.length === 0) return { action: 'reply', text: watchText.none('he') };
  const buttons = active.map((watch, index) => {
    const offer = deferred.offer({
      tool: 'reminders.when',
      compensating: { watchId: watch.id },
      principal: deps.principal,
      expiryMs: WATCH_CANCEL_EXPIRY_MS,
    });
    return { id: buttonId('undo', offer.id, offer.nonce, 'ok'), title: watchText.cancelButton(index + 1, 'he') };
  });
  return { action: 'reply', text: watchText.list(active, 'he'), buttons };
}

/**
 * `/followups` (block L, L2): the mail follow-ups still waiting, each with a
 * cancel button — a one-shot Undo offer of `mail.follow_up`, through the same
 * nonce, sender and expiry gates as any Undo. No model.
 */
function followUpsCommand(deps: PipelineDeps): PipelineOutcome {
  const followUps = deps.services?.followUps;
  const deferred = deps.services?.deferred;
  if (deps.channel !== 'app' || !followUps || !deferred) {
    return { action: 'reply', text: personalQuestion('watch_app_only', 'he') };
  }
  const active = followUps.active(deps.principal);
  if (active.length === 0) return { action: 'reply', text: followUpText.none('he') };
  const buttons = active.map((followUp, index) => {
    const offer = deferred.offer({
      tool: 'mail.follow_up',
      compensating: { followUpId: followUp.id },
      principal: deps.principal,
      expiryMs: WATCH_CANCEL_EXPIRY_MS,
    });
    return { id: buttonId('undo', offer.id, offer.nonce, 'ok'), title: followUpText.cancelButton(index + 1, 'he') };
  });
  return { action: 'reply', text: followUpText.list(active, 'he'), buttons };
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

    case 'missed':
    case 'misses':
    case 'memory':
    case 'forget_memory':
    case 'consents':
    case 'learn':
      // Answered before this, with the conversation it belongs to (§6.23).
      return missText.none;

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

  if (typeof command.set === 'object') {
    repo.setDigestSection(command.set.section, command.set.on);
    return statusText.digestSection(command.set.section, command.set.on);
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

/** `/forget` and `/pair off`: the agent's history, any lock and every conversation's mode go (§6.19). */
function forgetConversation(deps: PipelineDeps): void {
  deps.exchanges?.forget(deps.principal);
  deps.repo.forgetConversationModes(deps.principal);
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
  event: Pick<Extract<InboundEvent, { kind: 'text' | 'audio' | 'button' }>, 'sentAtMs' | 'forwarded' | 'mode'> & {
    location?: DeviceLocation;
  },
  now: number,
  source: TextSource,
  lang: Lang,
  /** The message's words, where a tool reads them in code (the market, §6.24). */
  text?: string,
): TurnContext {
  const services = deps.services;
  if (!services) throw new Error('E_SERVICES_MISSING');
  const marketWords = text !== undefined ? marketWordsIn(text) : undefined;

  return {
    ...(deps.learnSink ? { learn: deps.learnSink } : {}),
    tool: {
      principal: deps.principal,
      nowMs: now,
      lang,
      // Code reads the words for "remember about me" (§6.26); no words, no request.
      ...(text !== undefined ? { explicitFact: namesRememberAboutMe(text) } : {}),
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
      ...(services.pageText ? { pageText: services.pageText } : {}),
      ...(services.watches ? { watches: services.watches } : {}),
      ...(services.watchesChanged ? { watchesChanged: services.watchesChanged } : {}),
      ...(services.followUps ? { followUps: services.followUps } : {}),
      ...(services.suggestions ? { suggestions: services.suggestions } : {}),
      ...(services.archives ? { archives: services.archives } : {}),
      ...(deps.channel === 'app' && (deps.deviceCaps ?? []).includes('file') ? { fileCards: true } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(services.tasks ? { tasks: services.tasks } : {}),
      ...(services.gmail ? { gmail: services.gmail } : {}),
      ...(services.drive ? { drive: services.drive } : {}),
      ...(services.contacts ? { contacts: services.contacts } : {}),
      ...(services.birthdays ? { birthdays: services.birthdays } : {}),
      ...(services.notes ? { notes: services.notes } : {}),
      ...(services.lists ? { lists: services.lists } : {}),
      ...(services.facts ? { facts: services.facts } : {}),
      ...(services.holdings ? { holdings: services.holdings } : {}),
      ...(services.quotes ? { quotes: services.quotes } : {}),
      ...(marketWords ? { marketWords } : {}),
      ...(services.expenses ? { expenses: services.expenses } : {}),
      ...(services.routines ? { routines: services.routines } : {}),
      ...(services.screen ? { screen: services.screen } : {}),
      ...(services.drafts ? { drafts: services.drafts } : {}),
      ...(services.screenPush ? { screenPush: services.screenPush } : {}),
      // A smart conversation's own words, with its models here: a screen task
      // confirmed from it stays with Gemini (2026-10-13). Without them the
      // turn ran locally (the note above), and so does the task.
      ...(event.mode === 'smart' && !event.forwarded && services.agent?.smartProviders?.length ? { smart: true as const } : {}),
      ...(text !== undefined ? { userText: text } : {}),
    },
    pending: services.pending,
    deferred: services.deferred,
    messageSentAtMs: event.sentAtMs,
    forwarded: event.forwarded,
    // Text someone else wrote taints the turn (invariant 2).
    ...(event.forwarded ? { tainted: true } : {}),
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
    ...(reply.private ? { private: true as const } : {}),
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

/**
 * Whether the message names one of the routines the app synced, or says
 * "routine" outright (§6.27, decision D4). Code reads the words: the model is
 * offered `routine.run` only then, and code still finds the routine itself.
 */
export function namesRoutine(text: string, store: RoutineStore | undefined, principal: string): boolean {
  const names = store?.names(principal) ?? [];
  if (names.length === 0) return false;
  if (/שגר|רוטינ|\broutines?\b/i.test(text)) return true;
  const folded = foldForMatch(text);
  return names.some((routine) => {
    const name = foldForMatch(routine.name);
    return name.length > 0 && folded.includes(name);
  });
}
