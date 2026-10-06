/**
 * The `ToolDefinition` contract (PLAN §6.4).
 *
 * Three stages, deliberately separate:
 *
 *   resolve   slots from the LLM  -> a complete, validated input, or a question
 *   preview   input               -> a code-rendered summary for a confirmation
 *   execute   input               -> the action, and the reply
 *
 * `resolve` is where all the judgment lives, and it is pure code: it computes
 * times, finds targets, and refuses to fill a gap the user left. `execute` gets
 * something that is already known-good.
 *
 * Inputs cross a **JSON boundary** between the two whenever a confirmation is
 * involved: the input is stored, the user taps a button minutes later, and the
 * row comes back as `unknown`. So every `execute` re-validates its own input
 * against a Zod schema. The stored hash already guards against tampering; this
 * guards against everything else, and it is what makes the erased types here
 * honest rather than a cast.
 */
import type { NoteStore } from './note-store.js';
import type { ExpenseStore } from './expense-store.js';
import type { ZodTypeAny } from 'zod';
import type { Lang } from '../render/format-time.js';
import type { ClarifyTime } from '../time/resolve.js';
import type { ToolName } from './registry.js';
import type { ReminderStore } from './reminder-store.js';
import type { Repository } from '../core/repo.js';
import type { DeviceLocation } from '../channels/types.js';
import type { Logger } from '../security/redact.js';
import type { CalendarClient } from '../google/calendar.js';
import type { IcalStore } from '../ical/store.js';
import type { CallDispatcher } from '../device/calls.js';
import type { PhoneQuestion } from '../render/phone.js';
import type { GrantName } from '../google/grants.js';
import type { TasksClient } from '../google/tasks.js';
import type { GmailClient } from '../google/gmail.js';
import type { DriveClient } from '../google/drive.js';
import type { ContactsClient } from '../google/contacts.js';
import type { BirthdayStore } from '../core/birthdays.js';

/** One candidate when a description matched more than one thing. */
export type TargetChoice = { id: string; label: string };

/**
 * Why a tool cannot proceed. Stable codes only — the wording lives in
 * `src/render/`, so a question can be asked in either language from one place.
 */
export type Clarify =
  /** The user did not say something the tool cannot invent (PLAN §6.3 R11). */
  | { code: 'missing_slot'; slot: 'text' | 'time' | 'target' | 'title' | 'date' | 'duration' }
  /** The time resolver returned a question. Carries its rule and suggestion. */
  | { code: 'time'; detail: ClarifyTime }
  /** Nothing matched the description the user gave. */
  | { code: 'not_found' }
  /** Several things matched. The user picks by number or button. */
  | { code: 'ambiguous'; choices: TargetChoice[] }
  /** The request was well-formed but there is nothing to act on. */
  | { code: 'nothing_scheduled' }
  /** Google is not connected yet. */
  | { code: 'not_connected' }
  /** A Google grant other than the calendar's is not connected (2026-10-01). */
  | { code: 'grant_missing'; grant: GrantName }
  /** A call's target was a number, not a name on the phone (PLAN §6.17). */
  | { code: 'call_number_refused' }
  /**
   * A phone action is missing something (PLAN §6.20). Not recorded as an open
   * question: the answer goes back to the agent, which has the turn in history.
   */
  | { code: 'phone_missing'; what: PhoneQuestion }
  /**
   * Notes and expenses (2026-10-05): what to keep, how much, or a day that is
   * not a past one. Not recorded as an open question; the agent has the turn.
   */
  | { code: 'personal'; what: PersonalQuestion };

export type PersonalQuestion =
  | 'note_text'
  | 'notes_full'
  | 'no_notes'
  | 'expense_amount'
  | 'expense_future'
  | 'expense_too_old'
  | 'expense_invalid_date'
  | 'expenses_full'
  | 'no_expenses';

export type ResolveOutcome =
  | {
      kind: 'ready';
      /** Validated and complete. Safe to store and to execute later. */
      input: unknown;
      /** R8: far-future writes execute only after a confirmation. */
      needsConfirm?: boolean;
    }
  | { kind: 'clarify'; clarify: Clarify };

export type ToolContext = {
  principal: string;
  nowMs: number;
  lang: Lang;
  repo: Repository;
  reminders: ReminderStore;
  log: Logger;
  /** Start of the 24-hour window, for planning a reminder's delivery (§6.7). */
  lastInboundAt: number | null;
  /** Service messages used this month, for the same decision (§5). */
  monthlySent: number;
  /** Which channel the assistant speaks on. The app has no window and no budget (§6.18). */
  channel?: 'whatsapp' | 'app';
  /**
   * Present once Google is connected. Absent is not an error: a calendar tool
   * answers "not connected" rather than failing (PLAN §6.6).
   */
  calendar?: CalendarClient;
  /** A subscribed iCal feed, read-only and merged into calendar reads (§6.15). */
  ical?: IcalStore;
  /** Reaches the paired phone. Absent when calls are not configured (§6.17). */
  calls?: CallDispatcher;
  /**
   * Where the phone was when this message was sent (2026-10-01), for the
   * weather and the Hebrew calendar's times. This message only; never stored.
   */
  location?: DeviceLocation;
  /** For tools that read public data (`info.lookup`). Supplied by the platform. */
  fetchImpl?: typeof fetch;
  /** Google Tasks, once its grant is connected (2026-10-01). */
  tasks?: TasksClient;
  /** Gmail, once its grant is connected (2026-10-01). */
  gmail?: GmailClient;
  /** Google Drive's file search, once its grant is connected (2026-10-01). */
  drive?: DriveClient;
  /** Google Contacts' birthdays, once its grant is connected (2026-10-06). */
  contacts?: ContactsClient;
  /** The local birthday list (§6.16), for `birthdays.upcoming`. */
  birthdays?: BirthdayStore;
  /** Notes (§6.22). Absent only in tests that predate them. */
  notes?: NoteStore;
  /** Expenses (§6.22). Absent only in tests that predate them. */
  expenses?: ExpenseStore;
  /**
   * The turn already read text someone else wrote (§6.19). Set by `runIntent`
   * for the one tool that sends the model's words out: Wikipedia (2026-10-05).
   */
  tainted?: boolean;
};

export type ExecuteResult = {
  /** The reply. Code-rendered — the LLM never writes one (invariant 1). */
  text: string;
  /**
   * Tier 1 only: what an Undo would run, stored at execution time. A
   * compensating action written down now, never a re-reading of the request
   * later (PLAN §6.5).
   */
  compensating?: unknown;
  /** An id for the audit log. Never content. */
  externalRef?: string;
  /** Set when the action changed when the next alarm should fire. */
  rescheduleAlarm?: boolean;
  /**
   * This read carried text someone else wrote, so the agent's turn is tainted
   * from here on (§6.19) — for tools where only some results do (`info.lookup`).
   */
  tainting?: true;
  /**
   * The outcome is not known yet, and the one reply is sent when it is — a call
   * the phone has still to place (§6.17). `text` is then empty and unsent.
   */
  replyLater?: true;
};

export interface ToolDefinition {
  name: ToolName;
  /** Re-validated before every execute, including after a confirmation. */
  inputSchema: ZodTypeAny;
  /**
   * Synchronous, so policy can rule on a request before anything is fetched.
   * A tool that must look something up returns a placeholder here and does the
   * work in `resolveAsync`.
   */
  resolve(slots: unknown, ctx: ToolContext): ResolveOutcome;
  /**
   * For tools whose target lives behind the network — a calendar event has to
   * be found before it can be moved. Preferred over `resolve` when present.
   */
  resolveAsync?(slots: unknown, ctx: ToolContext): Promise<ResolveOutcome>;
  preview(input: unknown, lang: Lang): string;
  execute(input: unknown, ctx: ToolContext): Promise<ExecuteResult>;
  /** Present only on Tier 1 tools, which execute first and offer a way back. */
  undo?(compensating: unknown, ctx: ToolContext): Promise<ExecuteResult>;
  /**
   * Card tools only (PLAN §6.20): whether this particular input may run on the
   * phone without the tap, when policy allows it at all.
   */
  autoRunnable?(input: unknown): boolean;
}

/** Thrown when a stored input no longer matches its tool's schema. */
export class ToolInputError extends Error {
  constructor(readonly tool: string) {
    super('E_TOOL_INPUT_INVALID');
    this.name = 'ToolInputError';
  }
}

/** Parse a stored or freshly resolved input, or refuse to run. */
export function parseInput<T>(schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }, value: unknown, tool: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolInputError(tool);
  return parsed.data as T;
}
