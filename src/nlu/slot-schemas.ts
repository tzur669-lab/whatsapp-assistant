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
import { MAX_EXPRESSION_CHARS, UNITS } from '../lookup/calc.js';

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

/**
 * "כל יום ראשון ב-8 תזכיר לי לשים זבל" (B6). Agent-only: the parser's wire
 * schema is unchanged. Code computes every occurrence from the rule.
 */
export const remindersRepeatSlots = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    time: timeSpecSchema.optional(),
    every: z.enum(['day', 'week', 'month']).optional(),
    /** 0 = Sunday … 6 = Saturday, as in DateSpec. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    day_of_month: z.number().int().min(1).max(31).optional(),
  })
  .strict();

/** "תזיז את התזכורת של הרופא לשעה 5" (B8). Agent-only. */
export const remindersMoveSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
    to_date: dateSpecSchema.optional(),
    to_time: timeSpecSchema.optional(),
  })
  .strict();

/** "תזכיר לי שעה לפני כניסת שבת" (2026-10-05). Agent-only; code computes the time. */
export const remindersAtRestSlots = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    event: z.enum(['shabbat_start', 'shabbat_end', 'chag_start', 'chag_end']).optional(),
    /** Before a start, after an end. Absent: at the moment itself. */
    minutes: z.number().int().min(0).max(24 * 60).optional(),
  })
  .strict();

/**
 * "תזכיר לי מתי לצאת לפגישה עם דני" (ROADMAP #5, 2026-10-06). The event is
 * found in code, by its title's words or as the next timed one. The travel
 * time is the user's; absent, 30 minutes (the user's decision, 2026-10-06).
 */
export const remindersLeaveSlots = z
  .object({
    // Empty is accepted, as in notes.find: measured, a model sends [] for an
    // event it did not name. Code reads it as no event, and asks.
    event: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).max(MAX_QUERY_VARIANTS).optional(),
    next_event: z.boolean().optional(),
    minutes: z.number().int().min(5).max(240).optional(),
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

/**
 * "נווט הביתה". The destination is the user's words; Waze or Maps finds it.
 * Since 2026-10-06 (#21) it can instead be a contact, whose address the phone
 * looks up, or a calendar event, whose location code reads: exactly one.
 */
export const navGoSlots = z
  .object({
    destination: z.string().min(1).max(MAX_DESTINATION_CHARS).optional(),
    app: z.enum(['waze', 'maps']).optional(),
    /** A contact's name, matched on the phone; the address never leaves it. */
    contact: queryVariantsSchema.optional(),
    /** A calendar event's title, matched in code. */
    event: queryVariantsSchema.optional(),
    /** The next event that has a location. */
    next_event: z.boolean().optional(),
  })
  .strict();

/** "תפתח את ספוטיפיי". Matched against the phone's own installed apps. */
export const appOpenSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
  })
  .strict();

/**
 * "תפעיל את עומר אדם ביוטיוב מיוזיק" (2026-10-01). What to play, in words the
 * app searches for; a song is YouTube Music, a video YouTube. Which app, and
 * background or full screen, are asked when not said.
 */
export const mediaPlaySlots = z
  .object({
    app: z.enum(['youtube', 'youtube_music', 'spotify']).optional(),
    query: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
    mode: z.enum(['background', 'fullscreen']).optional(),
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

/** "מי התקשר אליי היום?", "פספסתי שיחות?" (#20, 2026-10-06). */
export const MAX_CALL_HOURS = 7 * 24;
export const phoneCallsSlots = z
  .object({
    /** A caller's name, as said. */
    name: z.string().min(1).max(MAX_SENDER_CHARS).optional(),
    /** Missed calls only. */
    missed: z.boolean().optional(),
    hours: z.number().int().min(1).max(MAX_CALL_HOURS).optional(),
  })
  .strict();

// -- public lookups (2026-10-01) ------------------------------------------------
//
// Agent-only, like the phone reads. One tool for four kinds of public data, so
// the catalog grows by one entry rather than four (every tool is prompt tokens).

export const LOOKUP_TOPICS = [
  'weather',
  'jewish_calendar',
  'exchange_rate',
  'news',
  // 2026-10-05 (ROADMAP block B): sunrise to nightfall, UV and air, Wikipedia.
  'day_times',
  'uv_air',
  'wikipedia',
] as const;

/**
 * The lookups a scheduled read may run (ROADMAP #7, 2026-10-05): a closed list
 * of Tier 0 public reads, each computed and rendered by code at the due time.
 * Wikipedia is not here: its query is free text, and a schedule would send it
 * out again and again with nobody there to see what it says.
 */
export const SCHEDULED_TOPICS = ['weather', 'day_times', 'uv_air', 'exchange_rate', 'news', 'jewish_calendar'] as const;
export type ScheduledTopic = (typeof SCHEDULED_TOPICS)[number];

/** "תשלח לי כל בוקר ב-7 את מזג האוויר" (#7). Agent-only; the rule as in reminders.repeat. */
export const remindersScheduledReadSlots = z
  .object({
    topic: z.enum(SCHEDULED_TOPICS).optional(),
    time: timeSpecSchema.optional(),
    every: z.enum(['day', 'week', 'month']).optional(),
    /** 0 = Sunday … 6 = Saturday, as in DateSpec. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    day_of_month: z.number().int().min(1).max(31).optional(),
  })
  .strict();

// -- notes and expenses (2026-10-05, ROADMAP #9, #10) ----------------------------
//
// Agent-only. A note's text is the user's own; the tools that show one are
// private (`ToolSpec.private`), so no note goes back to the model. An expense's
// day looks back, never forward (`src/time/past-day.ts`).

export const MAX_NOTE_TEXT_CHARS = 500;
export const MAX_EXPENSE_DESCRIPTION_CHARS = 60;

/** "תזכור שהקוד של השער הוא…". */
export const notesSaveSlots = z
  .object({ text: z.string().min(1).max(MAX_NOTE_TEXT_CHARS).optional() })
  .strict();

/**
 * "מה רשמתי על השער?". Absent or empty: the newest notes — measured: a model
 * asked for "all my notes" sends an empty list (2026-10-05).
 */
export const notesFindSlots = z
  .object({ query_variants: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).max(MAX_QUERY_VARIANTS).optional() })
  .strict();

export const notesDeleteSlots = z.object({ query_variants: queryVariantsSchema.optional() }).strict();

// ROADMAP block H (2026-10-07). Agent-only, private like notes. A list is named
// by `list`: the words the user called it, matched in code (invariant 5).

export const MAX_LIST_ITEM_CHARS = 200;
export const MAX_LIST_ITEMS_PER_CALL = 20;

const listItemsSchema = z.array(z.string().min(1).max(MAX_LIST_ITEM_CHARS)).min(1).max(MAX_LIST_ITEMS_PER_CALL);

/** "תוסיף חלב וביצים לרשימת קניות". */
export const listsAddSlots = z
  .object({ list: queryVariantsSchema.optional(), items: listItemsSchema.optional() })
  .strict();

/** "מה ברשימת הקניות?", "אילו רשימות יש לי?". Absent: every list. */
export const listsShowSlots = z
  .object({ list: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).max(MAX_QUERY_VARIANTS).optional() })
  .strict();

/** "תוריד את החלב מהרשימה". */
export const listsRemoveSlots = z
  .object({ list: queryVariantsSchema.optional(), items: listItemsSchema.optional() })
  .strict();

/** "תמחק את רשימת הקניות". */
export const listsDeleteSlots = z.object({ list: queryVariantsSchema.optional() }).strict();

// ROADMAP block H part 18 (2026-10-07). Agent-only. A fact is about the user and
// the model sees it on every turn; only an explicit "about me" signal saves one.

export const MAX_FACT_TEXT_CHARS = 200;

/** "תזכור עליי שאני גר ברחובות". */
export const memoryRememberSlots = z.object({ text: z.string().min(1).max(MAX_FACT_TEXT_CHARS).optional() }).strict();

/** "תשכח שאני צמחוני". */
export const memoryForgetSlots = z.object({ query_variants: queryVariantsSchema.optional() }).strict();

export const EXPENSE_CATEGORY_SLOTS = [
  'food',
  'groceries',
  'fuel',
  'transport',
  'shopping',
  'bills',
  'health',
  'fun',
  'home',
  'other',
] as const;

/** A past date, as said. Without a year: the latest such date. */
export const spentOnSchema = z
  .object({
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2020).max(2100).optional(),
  })
  .strict();

/**
 * "הוצאתי 45 על קפה". Shekels only. The day is flat slots that look back —
 * not a DateSpec, whose `relative_days` counts forward: measured, a model
 * wrote "yesterday" as `{relative_days, offset: 1}`, which is tomorrow there.
 */
export const expensesAddSlots = z
  .object({
    amount: z.number().positive().max(1_000_000).optional(),
    category: z.enum(EXPENSE_CATEGORY_SLOTS).optional(),
    description: z.string().min(1).max(MAX_EXPENSE_DESCRIPTION_CHARS).optional(),
    /** 0 = today, 1 = yesterday. */
    days_ago: z.number().int().min(0).max(366).optional(),
    /** The latest such weekday, today included. 0 = Sunday. */
    weekday: z.number().int().min(0).max(6).optional(),
    on_date: spentOnSchema.optional(),
  })
  .strict();

export const EXPENSE_PERIODS = ['today', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'all'] as const;

/** "כמה הוצאתי החודש על אוכל?". Absent period: this month. */
export const expensesSummarySlots = z
  .object({
    period: z.enum(EXPENSE_PERIODS).optional(),
    category: z.enum(EXPENSE_CATEGORY_SLOTS).optional(),
  })
  .strict();

/** "תייצא לי את ההוצאות לאקסל". Absent period: everything. */
export const expensesExportSlots = z.object({ period: z.enum(EXPENSE_PERIODS).optional() }).strict();

export const infoLookupSlots = z
  .object({
    topic: z.enum(LOOKUP_TOPICS),
    /** A city, for weather and candle lighting. Absent: the user's home city. */
    place: z.string().min(1).max(60).optional(),
    date: dateSpecSchema.optional(),
    /** An ISO 4217 code, for exchange rates. */
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    amount: z.number().positive().max(1_000_000_000).optional(),
    /** What to look up on Wikipedia, in the user's words. */
    query: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
  })
  .strict();

// -- calculator and free time (2026-10-05) ------------------------------------
//
// Agent-only. The model writes the arithmetic; code reads and computes it
// (`src/lookup/calc.ts`), so a model never does sums it may get wrong.

export const calcComputeSlots = z
  .object({
    expression: z.string().min(1).max(MAX_EXPRESSION_CHARS).optional(),
    /** A conversion: the expression's value, from one unit to another. */
    from_unit: z.enum(UNITS).optional(),
    to_unit: z.enum(UNITS).optional(),
  })
  .strict();

export const MIN_FREE_MINUTES = 15;
export const MAX_FREE_MINUTES = 480;

export const calendarFreeTimeSlots = z
  .object({
    date: dateSpecSchema.optional(),
    range: rangeSchema.optional(),
    /** The shortest gap worth naming. Absent: half an hour. */
    minutes: z.number().int().min(MIN_FREE_MINUTES).max(MAX_FREE_MINUTES).optional(),
  })
  .strict();

// -- Google Tasks (2026-10-01) ------------------------------------------------
//
// Agent-only. A list is named the way the user says it ("קניות"); code finds it.

export const MAX_LIST_CHARS = 60;

export const tasksListSlots = z
  .object({ list: z.string().min(1).max(MAX_LIST_CHARS).optional() })
  .strict();

export const tasksAddSlots = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    list: z.string().min(1).max(MAX_LIST_CHARS).optional(),
    /** A due date. Tasks has no time of day. */
    date: dateSpecSchema.optional(),
  })
  .strict();

export const tasksCompleteSlots = z
  .object({
    query_variants: queryVariantsSchema.optional(),
    list: z.string().min(1).max(MAX_LIST_CHARS).optional(),
  })
  .strict();

// -- Gmail (2026-10-01) ---------------------------------------------------------
//
// Agent-only. The model says who and what; code builds the Gmail query, finds
// the message, and holds every address.

export const MAX_MAIL_BODY_CHARS = 2_000;

export const MAX_MAIL_DAYS = 365;
export const MAX_MAIL_COUNT = 10;

export const mailSearchSlots = z
  .object({
    /** A sender's name, as said. */
    from: z.string().min(1).max(60).optional(),
    /** Words of the subject or the text. */
    about: z.string().min(1).max(100).optional(),
    unread: z.boolean().optional(),
    /** How many days back. Default 30, at most a year. */
    days: z.number().int().min(1).max(MAX_MAIL_DAYS).optional(),
    /** How many mails, newest first: 1 for "the last mail". Default 6. */
    count: z.number().int().min(1).max(MAX_MAIL_COUNT).optional(),
    /** Read the text of the newest match, not only its first lines. */
    full: z.boolean().optional(),
  })
  .strict();

export const mailDraftSlots = z
  .object({
    /** Who or what to reply to, found by code among recent mail. Absent: a new draft with no recipient. */
    reply_to: queryVariantsSchema.optional(),
    subject: z.string().min(1).max(150).optional(),
    body: z.string().min(1).max(MAX_MAIL_BODY_CHARS).optional(),
  })
  .strict();

// -- Google Drive (2026-10-01) ---------------------------------------------------

export const driveSearchSlots = z
  .object({
    /** Words of the file's name. */
    name: z.string().min(1).max(100).optional(),
    kind: z.enum(['any', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'folder']).optional(),
    /** Changed within this many days. */
    days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

// -- block E (2026-10-06) ---------------------------------------------------------

export const MAX_BIRTHDAY_DAYS = 90;

/** "של מי יום הולדת השבוע?", "מתי יום ההולדת של דנה?" (#11). */
export const birthdaysUpcomingSlots = z
  .object({
    /** A person's name: that person's birthday, whenever it is. */
    query_variants: queryVariantsSchema.optional(),
    /** How many days ahead. Default 30. */
    days: z.number().int().min(1).max(MAX_BIRTHDAY_DAYS).optional(),
  })
  .strict();

export const MAX_BILL_DAYS = 120;

/** "אילו חשבונות יש לי לשלם?" (#24). The query is code's; the model says how far back. */
export const mailBillsSlots = z
  .object({
    days: z.number().int().min(1).max(MAX_BILL_DAYS).optional(),
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
