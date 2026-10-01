/**
 * Zod schemas for the slots the LLM may emit (PLAN §6.2, §6.4).
 *
 * LLM output is untrusted input (CLAUDE.md invariant 3). Every object is
 * `.strict()` so an unexpected key is a rejection rather than a silently
 * ignored field, every enum is closed, and every string is length-capped.
 *
 * `DateSpec` and `TimeSpec` mirror the types in `src/time/resolve.ts`, which
 * owns them. The assignability checks at the bottom of this file fail the build
 * if the two ever drift apart.
 */
import { z } from 'zod';
import type { DateSpec, TimeSpec } from '../time/resolve.js';

export const MAX_TITLE_CHARS = 200;
export const MAX_QUERY_VARIANTS = 5;
export const MAX_QUERY_CHARS = 100;
export const MAX_ATTENDEES = 10;

// -- primitives ---------------------------------------------------------------

export const dateSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('relative_days'),
      // Today = 0, מחר = 1, מחרתיים = 2. Capped well inside the R8 horizon.
      offset: z.number().int().min(0).max(400),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekday'),
      weekday: z.union([
        z.literal(0), z.literal(1), z.literal(2), z.literal(3),
        z.literal(4), z.literal(5), z.literal(6),
      ]),
      qualifier: z.enum(['this', 'next', 'unspecified']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('absolute'),
      day: z.number().int().min(1).max(31),
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(2020).max(2100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('in_duration'),
      minutes: z.number().int().min(1).max(365 * 24 * 60),
    })
    .strict(),
]);

export const timeSpecSchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    meridiem: z.enum(['am', 'pm', 'unspecified']),
    part_of_day: z.enum(['morning', 'noon', 'afternoon', 'evening', 'night', 'unspecified']),
  })
  .strict();

/**
 * A multi-day span the user asked about. Code turns it into dates.
 *
 * Single days are deliberately absent. `today` and `tomorrow` were in this enum
 * and overlapped exactly with `relative_days` 0 and 1, so "what's on my calendar
 * tomorrow" had two equally valid encodings and models picked either one. One
 * meaning, one representation: a single day is always a `date`.
 */
export const rangeSchema = z.enum(['this_week', 'next_week', 'weekend']);

/**
 * Spellings of an event or reminder the user referred to. Code matches these;
 * the LLM never supplies an id (CLAUDE.md invariant 5).
 */
export const queryVariantsSchema = z
  .array(z.string().min(1).max(MAX_QUERY_CHARS))
  .min(1)
  .max(MAX_QUERY_VARIANTS);

// -- per-tool slots -----------------------------------------------------------
//
// Every slot is optional here on purpose. The schema validates SHAPE: closed
// enums, capped lengths, no unknown keys. COMPLETENESS is a separate question,
// answered later by each tool's `resolve`, which returns CLARIFY for what is
// absent.
//
// They have to be separate. The prompt contract forbids the model from filling a
// slot the user did not state (PLAN §6.2) and requires it to declare the gap in
// `missing` instead. If the schema rejected an incomplete draft, that instruction
// would be unfollowable and the "missing-slot detection 100%" threshold in §11.2
// could never be met.

export const remindersCreateSlots = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    date: dateSpecSchema.optional(),
    time: timeSpecSchema.optional(),
  })
  .strict();

export const remindersListSlots = z
  .object({
    range: rangeSchema.optional(),
  })
  .strict();

export const remindersCancelSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
    date: dateSpecSchema.optional(),
  })
  .strict();

export const calendarListEventsSlots = z
  .object({
    date: dateSpecSchema.optional(),
    range: rangeSchema.optional(),
  })
  .strict();

export const calendarCreateEventSlots = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    date: dateSpecSchema.optional(),
    time: timeSpecSchema.optional(),
    duration_minutes: z.number().int().min(1).max(24 * 60).optional(),
    // Attendees push the tool to Tier 3. Names only — code resolves addresses.
    attendees: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).max(MAX_ATTENDEES).optional(),
  })
  .strict();

export const calendarMoveEventSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
    from_date: dateSpecSchema.optional(),
    from_time: timeSpecSchema.optional(),
    to_date: dateSpecSchema.optional(),
    to_time: timeSpecSchema.optional(),
  })
  .strict();

export const calendarDeleteEventSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
    date: dateSpecSchema.optional(),
    time: timeSpecSchema.optional(),
  })
  .strict();

/**
 * "תתקשר לדוד דני". The words only — never a number, which `calls.place`
 * refuses, and never an id: the phone matches them against its own contacts
 * (PLAN §6.17). A new tool, but not a new slot: the wire schema's flat union
 * is unchanged.
 */
export const callsPlaceSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
  })
  .strict();

// -- phone actions (PLAN §6.20) ------------------------------------------------
//
// Agent-only tools: the parser's catalog and wire schema never offer them. Each
// becomes an action card the phone runs after a signed claim. Words only — the
// phone matches a contact or an app against its own lists.

export const MAX_LABEL_CHARS = 60;
export const MAX_DESTINATION_CHARS = 100;
export const MAX_MESSAGE_CHARS = 500;

/** "תעיר אותי ב-6:30". An alarm is an hour and a minute; the phone sets the next one. */
export const alarmSetSlots = z
  .object({
    time: timeSpecSchema.optional(),
    label: z.string().min(1).max(MAX_LABEL_CHARS).optional(),
  })
  .strict();

/** "טיימר ל-10 דקות". */
export const timerSetSlots = z
  .object({
    duration_minutes: z.number().int().min(1).max(24 * 60).optional(),
    label: z.string().min(1).max(MAX_LABEL_CHARS).optional(),
  })
  .strict();

/** "נווט הביתה". The destination is the user's words; Waze or Maps finds it. */
export const navGoSlots = z
  .object({
    destination: z.string().min(1).max(MAX_DESTINATION_CHARS).optional(),
    app: z.enum(['waze', 'maps']).optional(),
  })
  .strict();

/** "תפתח את ספוטיפיי". Matched against the phone's own installed apps. */
export const appOpenSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
  })
  .strict();

/** "תדליק פנס", "שים על שקט". Android lets an app toggle only some of these. */
export const settingsSetSlots = z
  .object({
    setting: z.enum(['flashlight', 'dnd', 'ringer', 'wifi', 'bluetooth']).optional(),
    state: z.enum(['on', 'off', 'silent', 'vibrate', 'normal']).optional(),
  })
  .strict();

/**
 * "תשלח לאמא בוואטסאפ שאני מאחר". The recipient is words matched on the phone;
 * the text is shown in full on the card, and the user presses send in the
 * messaging app itself.
 */
export const messageComposeSlots = z
  .object({
    channel: z.enum(['sms', 'whatsapp']).optional(),
    query_variants: queryVariantsSchema.optional(),
    text: z.string().min(1).max(MAX_MESSAGE_CHARS).optional(),
  })
  .strict();

// -- phone reads (PLAN §6.21) ---------------------------------------------------
// Agent-only, app-only, typed messages only. The phone reads its own data and
// sends back a capped, minimized list; nothing here is ever an action.

export const MAX_APP_NAME_CHARS = 40;
export const MAX_SENDER_CHARS = 40;
/** The notification buffer on the phone keeps a day. */
export const MAX_NOTIFICATION_HOURS = 24;
export const MAX_SMS_HOURS = 7 * 24;

/** "יש לי את המספר של דני?". Names only come back, never a number. */
export const phoneContactsSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
  })
  .strict();

/** "מה ההתראות האחרונות מוואטסאפ?". `app_name`, not `app`: `nav.go` owns that slot. */
export const phoneNotificationsSlots = z
  .object({
    app_name: z.string().min(1).max(MAX_APP_NAME_CHARS).optional(),
    hours: z.number().int().min(1).max(MAX_NOTIFICATION_HOURS).optional(),
  })
  .strict();

/** "מה כתבו לי ב-SMS היום?". */
export const phoneSmsSlots = z
  .object({
    sender: z.string().min(1).max(MAX_SENDER_CHARS).optional(),
    hours: z.number().int().min(1).max(MAX_SMS_HOURS).optional(),
  })
  .strict();

// -- drift guards -------------------------------------------------------------
// These are compile-time only. If `src/time/resolve.ts` gains a DateSpec variant
// that this file does not model, or vice versa, typecheck fails here rather than
// at runtime on a real message.

type SchemaDateSpec = z.infer<typeof dateSpecSchema>;
type SchemaTimeSpec = z.infer<typeof timeSpecSchema>;

function assertSameShape<A, _B extends A>(): void {
  /* type-level only */
}

assertSameShape<DateSpec, SchemaDateSpec>();
assertSameShape<SchemaDateSpec, DateSpec>();
assertSameShape<TimeSpec, SchemaTimeSpec>();
assertSameShape<SchemaTimeSpec, TimeSpec>();
