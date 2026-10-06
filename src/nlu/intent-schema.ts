/**
 * The `IntentDraft` contract (PLAN §6.2).
 *
 * This is the only door LLM output passes through. Anything that does not match
 * exactly is rejected — there is no coercion and no "best effort" path. A
 * rejected draft becomes a clarification, never an action.
 *
 * One narrow, measured exception: a slot that belongs to a different tool is
 * removed rather than rejected (`projectSlots`). Nothing is ever coerced or
 * filled in; a value that is present and declared is validated in full.
 */
import { z } from 'zod';
import { TOOL_NAMES } from '../tools/registry.js';
import {
  alarmSetSlots,
  appOpenSlots,
  mediaPlaySlots,
  birthdaysUpcomingSlots,
  mailBillsSlots,
  phoneCallsSlots,
  calendarCreateEventSlots,
  calendarDeleteEventSlots,
  calendarListEventsSlots,
  calendarMoveEventSlots,
  callsPlaceSlots,
  messageComposeSlots,
  navGoSlots,
  phoneContactsSlots,
  phoneNotificationsSlots,
  phoneSmsSlots,
  infoLookupSlots,
  tasksAddSlots,
  mailDraftSlots,
  mailSearchSlots,
  driveSearchSlots,
  calcComputeSlots,
  calendarFreeTimeSlots,
  tasksCompleteSlots,
  tasksListSlots,
  remindersAtRestSlots,
  remindersScheduledReadSlots,
  remindersLeaveSlots,
  notesSaveSlots,
  notesFindSlots,
  notesDeleteSlots,
  expensesAddSlots,
  expensesSummarySlots,
  expensesExportSlots,
  remindersCancelSlots,
  remindersCreateSlots,
  remindersListSlots,
  remindersMoveSlots,
  remindersRepeatSlots,
  settingsSetSlots,
  timerSetSlots,
} from './slot-schemas.js';

export const MAX_MISSING_SLOTS = 8;
export const MAX_AMBIGUITIES = 8;
export const MAX_NOTE_CHARS = 200;

const languageSchema = z.enum(['he', 'en']);

const missingSchema = z
  .array(z.string().min(1).max(40))
  .max(MAX_MISSING_SLOTS)
  .default([]);

const ambiguitiesSchema = z
  .array(
    z
      .object({
        slot: z.string().min(1).max(40),
        note: z.string().min(1).max(MAX_NOTE_CHARS),
      })
      .strict(),
  )
  .max(MAX_AMBIGUITIES)
  .default([]);

/**
 * Slots tolerated on an `unsupported` draft.
 *
 * `unsupported` means "no tool handles this", and its slots are never read. An
 * empty-object rule looked tighter but turned correct classifications into hard
 * failures: strict structured output requires the model to emit every slot key,
 * and a message like "what's the weather tomorrow" legitimately contains a date.
 * Rejecting the draft over an ignored field would punish the right answer.
 */
const ignoredSlots = remindersCreateSlots
  .merge(remindersListSlots)
  .merge(remindersCancelSlots)
  .merge(calendarListEventsSlots)
  .merge(calendarCreateEventSlots)
  .merge(calendarMoveEventSlots)
  .merge(calendarDeleteEventSlots)
  .merge(alarmSetSlots)
  .merge(timerSetSlots)
  .merge(navGoSlots)
  .merge(settingsSetSlots)
  .merge(messageComposeSlots)
  .merge(phoneContactsSlots)
  .merge(phoneNotificationsSlots)
  .merge(phoneSmsSlots)
  // Partial: `topic` is required of a lookup, never of an ignored draft.
  .merge(infoLookupSlots.partial())
  .merge(tasksListSlots)
  .merge(tasksAddSlots)
  .merge(tasksCompleteSlots)
  .merge(mailSearchSlots)
  .merge(mailDraftSlots)
  .merge(driveSearchSlots)
  .strict();

const common = {
  language: languageSchema,
  missing: missingSchema,
  ambiguities: ambiguitiesSchema,
};

/**
 * A discriminated union on `intent`, so each intent is validated against its own
 * slots. A slot that belongs to another tool never reaches this schema: it is
 * removed first by `projectSlots`, below, and only that kind of key is.
 */
export const intentDraftSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('reminders.create'), slots: remindersCreateSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.list'), slots: remindersListSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.cancel'), slots: remindersCancelSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.list_events'), slots: calendarListEventsSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.create_event'), slots: calendarCreateEventSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.move_event'), slots: calendarMoveEventSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.delete_event'), slots: calendarDeleteEventSlots, ...common }).strict(),
  z.object({ intent: z.literal('calls.place'), slots: callsPlaceSlots, ...common }).strict(),
  // Agent-only reminders (2026-10-05). Not in `ignoredSlots`: the parser's wire
  // schema never offers them, so an `unsupported` draft never carries them.
  z.object({ intent: z.literal('reminders.repeat'), slots: remindersRepeatSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.move'), slots: remindersMoveSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.at_rest'), slots: remindersAtRestSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.scheduled_read'), slots: remindersScheduledReadSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.leave'), slots: remindersLeaveSlots, ...common }).strict(),
  // Phone actions (§6.20). Agent-only; the parser's wire schema never offers them.
  z.object({ intent: z.literal('alarm.set'), slots: alarmSetSlots, ...common }).strict(),
  z.object({ intent: z.literal('timer.set'), slots: timerSetSlots, ...common }).strict(),
  z.object({ intent: z.literal('nav.go'), slots: navGoSlots, ...common }).strict(),
  z.object({ intent: z.literal('app.open'), slots: appOpenSlots, ...common }).strict(),
  z.object({ intent: z.literal('media.play'), slots: mediaPlaySlots, ...common }).strict(),
  z.object({ intent: z.literal('settings.set'), slots: settingsSetSlots, ...common }).strict(),
  z.object({ intent: z.literal('message.compose'), slots: messageComposeSlots, ...common }).strict(),
  // Phone reads (§6.21). Agent-only, like the phone actions.
  z.object({ intent: z.literal('phone.contacts'), slots: phoneContactsSlots, ...common }).strict(),
  z.object({ intent: z.literal('phone.notifications'), slots: phoneNotificationsSlots, ...common }).strict(),
  z.object({ intent: z.literal('phone.sms'), slots: phoneSmsSlots, ...common }).strict(),
  // Public lookups (2026-10-01). Agent-only.
  z.object({ intent: z.literal('info.lookup'), slots: infoLookupSlots, ...common }).strict(),
  // ROADMAP block B (2026-10-05). Agent-only, and not in `ignoredSlots`, like
  // the agent-only reminders.
  z.object({ intent: z.literal('calc.compute'), slots: calcComputeSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.free_time'), slots: calendarFreeTimeSlots, ...common }).strict(),
  // ROADMAP block D (2026-10-05). Agent-only.
  z.object({ intent: z.literal('notes.save'), slots: notesSaveSlots, ...common }).strict(),
  z.object({ intent: z.literal('notes.find'), slots: notesFindSlots, ...common }).strict(),
  z.object({ intent: z.literal('notes.delete'), slots: notesDeleteSlots, ...common }).strict(),
  z.object({ intent: z.literal('expenses.add'), slots: expensesAddSlots, ...common }).strict(),
  z.object({ intent: z.literal('expenses.summary'), slots: expensesSummarySlots, ...common }).strict(),
  z.object({ intent: z.literal('expenses.export'), slots: expensesExportSlots, ...common }).strict(),
  // Google Tasks (2026-10-01). Agent-only.
  z.object({ intent: z.literal('tasks.list'), slots: tasksListSlots, ...common }).strict(),
  z.object({ intent: z.literal('tasks.add'), slots: tasksAddSlots, ...common }).strict(),
  z.object({ intent: z.literal('tasks.complete'), slots: tasksCompleteSlots, ...common }).strict(),
  // Gmail (2026-10-01). Agent-only.
  z.object({ intent: z.literal('mail.search'), slots: mailSearchSlots, ...common }).strict(),
  z.object({ intent: z.literal('mail.draft'), slots: mailDraftSlots, ...common }).strict(),
  // Google Drive (2026-10-01). Agent-only.
  z.object({ intent: z.literal('drive.search'), slots: driveSearchSlots, ...common }).strict(),
  // ROADMAP block E (2026-10-06). Agent-only.
  z.object({ intent: z.literal('birthdays.upcoming'), slots: birthdaysUpcomingSlots, ...common }).strict(),
  z.object({ intent: z.literal('mail.bills'), slots: mailBillsSlots, ...common }).strict(),
  z.object({ intent: z.literal('phone.calls'), slots: phoneCallsSlots, ...common }).strict(),
  // Anything outside the tool list, including prompt-injection attempts.
  z.object({ intent: z.literal('unsupported'), slots: ignoredSlots, ...common }).strict(),
]);

export type IntentDraft = z.infer<typeof intentDraftSchema>;
export type IntentName = IntentDraft['intent'];

export const INTENT_NAMES: readonly IntentName[] = [...TOOL_NAMES, 'unsupported'] as const;

export type ValidationResult =
  | {
      ok: true;
      draft: IntentDraft;
      /**
       * Slot names removed because they belong to another tool (see
       * `projectSlots`). Names from a closed vocabulary, never values — safe to
       * log, and worth logging: a model that starts doing this often is drifting.
       */
      strippedSlots: readonly string[];
    }
  | { ok: false; errorCode: 'schema_invalid'; issues: string[] };

/** Each tool's own slots, by intent. `unsupported` is absent: it keeps them all. */
const TOOL_SLOTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'reminders.create': new Set(Object.keys(remindersCreateSlots.shape)),
  'reminders.list': new Set(Object.keys(remindersListSlots.shape)),
  'reminders.cancel': new Set(Object.keys(remindersCancelSlots.shape)),
  'calendar.list_events': new Set(Object.keys(calendarListEventsSlots.shape)),
  'calendar.create_event': new Set(Object.keys(calendarCreateEventSlots.shape)),
  'calendar.move_event': new Set(Object.keys(calendarMoveEventSlots.shape)),
  'calendar.delete_event': new Set(Object.keys(calendarDeleteEventSlots.shape)),
  'calls.place': new Set(Object.keys(callsPlaceSlots.shape)),
  'alarm.set': new Set(Object.keys(alarmSetSlots.shape)),
  'timer.set': new Set(Object.keys(timerSetSlots.shape)),
  'nav.go': new Set(Object.keys(navGoSlots.shape)),
  'app.open': new Set(Object.keys(appOpenSlots.shape)),
  'media.play': new Set(Object.keys(mediaPlaySlots.shape)),
  'settings.set': new Set(Object.keys(settingsSetSlots.shape)),
  'message.compose': new Set(Object.keys(messageComposeSlots.shape)),
  'phone.contacts': new Set(Object.keys(phoneContactsSlots.shape)),
  'phone.notifications': new Set(Object.keys(phoneNotificationsSlots.shape)),
  'phone.sms': new Set(Object.keys(phoneSmsSlots.shape)),
  'info.lookup': new Set(Object.keys(infoLookupSlots.shape)),
  'tasks.list': new Set(Object.keys(tasksListSlots.shape)),
  'tasks.add': new Set(Object.keys(tasksAddSlots.shape)),
  'tasks.complete': new Set(Object.keys(tasksCompleteSlots.shape)),
  'mail.search': new Set(Object.keys(mailSearchSlots.shape)),
  'mail.draft': new Set(Object.keys(mailDraftSlots.shape)),
  'drive.search': new Set(Object.keys(driveSearchSlots.shape)),
  'calc.compute': new Set(Object.keys(calcComputeSlots.shape)),
  'calendar.free_time': new Set(Object.keys(calendarFreeTimeSlots.shape)),
};

/** Every slot any tool declares — the flat union the wire schema offers the model. */
const ANY_TOOL_SLOT: ReadonlySet<string> = new Set(Object.keys(ignoredSlots.shape));

/**
 * Remove, from a tool's draft, the slots that belong to a **different** tool.
 *
 * Decided 2026-09-26 (PLAN §13, §14), on measurement. Strict structured output
 * cannot express per-intent slot sets — Groq requires a single root object — so
 * the wire schema offers the model one flat `slots` object holding every tool's
 * slots, and a model will sometimes fill one that is not its tool's. On the
 * first complete corpus four answers were thrown away for exactly this —
 * `attendees` on a `calendar.delete_event` draft — and every one of them was
 * otherwise perfect: intent, date, and target all right. Rejecting them turned
 * correct answers into clarifications over a field no code would ever read.
 *
 * The line is drawn tightly, because strict is still what makes this output
 * safe to act on:
 *
 *   - Only a name some *other tool* declares is removed. A name no tool
 *     declares cannot come out of strict generation at all, so if one appears
 *     something is really wrong, and it is still a rejection.
 *   - Only at the top of `slots`. Dates, times and every nested shape stay
 *     strict, and a declared slot with a bad value still rejects the draft.
 *   - The removed slot is one the tool never reads, so it cannot influence any
 *     action; policy, tiers and confirmation all run on what remains.
 *   - `unsupported` is untouched: it already tolerates every slot, for the same
 *     reason, since 2026-09-24.
 *
 * Never mutates its input.
 */
function projectSlots(raw: unknown): { value: unknown; stripped: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: raw, stripped: [] };
  }
  const record = raw as Record<string, unknown>;
  const intent = record['intent'];
  const slots = record['slots'];
  const own = typeof intent === 'string' ? TOOL_SLOTS[intent] : undefined;
  if (own === undefined || typeof slots !== 'object' || slots === null || Array.isArray(slots)) {
    return { value: raw, stripped: [] };
  }

  const kept: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(slots as Record<string, unknown>)) {
    if (!own.has(key) && ANY_TOOL_SLOT.has(key)) {
      stripped.push(key);
    } else {
      kept[key] = value;
    }
  }
  return stripped.length === 0
    ? { value: raw, stripped }
    : { value: { ...record, slots: kept }, stripped };
}

/**
 * Validate raw provider output. Issue paths are returned for logging; issue
 * *values* are not, because they would echo the user's own words.
 */
export function validateIntentDraft(raw: unknown): ValidationResult {
  const projected = projectSlots(raw);
  const parsed = intentDraftSchema.safeParse(projected.value);
  if (parsed.success) return { ok: true, draft: parsed.data, strippedSlots: projected.stripped };

  return {
    ok: false,
    errorCode: 'schema_invalid',
    issues: parsed.error.issues.slice(0, 10).map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.code}`;
    }),
  };
}
