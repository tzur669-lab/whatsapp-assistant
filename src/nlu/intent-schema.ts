/**
 * The `IntentDraft` contract (PLAN §6.2).
 *
 * This is the only door LLM output passes through. Anything that does not match
 * exactly is rejected — there is no coercion, no partial acceptance, and no
 * "best effort" path. A rejected draft becomes a clarification, never an action.
 */
import { z } from 'zod';
import { TOOL_NAMES } from '../tools/registry.js';
import {
  calendarCreateEventSlots,
  calendarDeleteEventSlots,
  calendarListEventsSlots,
  calendarMoveEventSlots,
  remindersCancelSlots,
  remindersCreateSlots,
  remindersListSlots,
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

const common = {
  language: languageSchema,
  missing: missingSchema,
  ambiguities: ambiguitiesSchema,
};

/**
 * A discriminated union on `intent`, so each intent is validated against its own
 * slots. A slot that belongs to another tool is a rejection, not a stray field.
 */
export const intentDraftSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('reminders.create'), slots: remindersCreateSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.list'), slots: remindersListSlots, ...common }).strict(),
  z.object({ intent: z.literal('reminders.cancel'), slots: remindersCancelSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.list_events'), slots: calendarListEventsSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.create_event'), slots: calendarCreateEventSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.move_event'), slots: calendarMoveEventSlots, ...common }).strict(),
  z.object({ intent: z.literal('calendar.delete_event'), slots: calendarDeleteEventSlots, ...common }).strict(),
  // Anything outside the tool list, including prompt-injection attempts.
  z.object({ intent: z.literal('unsupported'), slots: z.object({}).strict(), ...common }).strict(),
]);

export type IntentDraft = z.infer<typeof intentDraftSchema>;
export type IntentName = IntentDraft['intent'];

export const INTENT_NAMES: readonly IntentName[] = [...TOOL_NAMES, 'unsupported'] as const;

export type ValidationResult =
  | { ok: true; draft: IntentDraft }
  | { ok: false; errorCode: 'schema_invalid'; issues: string[] };

/**
 * Validate raw provider output. Issue paths are returned for logging; issue
 * *values* are not, because they would echo the user's own words.
 */
export function validateIntentDraft(raw: unknown): ValidationResult {
  const parsed = intentDraftSchema.safeParse(raw);
  if (parsed.success) return { ok: true, draft: parsed.data };

  return {
    ok: false,
    errorCode: 'schema_invalid',
    issues: parsed.error.issues.slice(0, 10).map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.code}`;
    }),
  };
}
