/**
 * The tool registry — the single source of truth for what the assistant can do
 * (PLAN §6.4). The LLM catalog is generated from here; prompt tool lists are
 * never hand-written (CLAUDE.md, "Adding or changing a tool").
 *
 * Phase 3 declares the LLM-facing contract of each tool: its name, the
 * description the model sees, the slots it may emit, its tier, and its Google
 * scopes. `resolve`, `preview` and `execute` are added per tool in Phases 4-6;
 * until then a tool can be parsed but not run, which is the safe half to build
 * first.
 */
import type { ZodTypeAny } from 'zod';
import {
  alarmSetSlots,
  appOpenSlots,
  calcComputeSlots,
  calendarFreeTimeSlots,
  calendarCreateEventSlots,
  calendarDeleteEventSlots,
  calendarListEventsSlots,
  calendarMoveEventSlots,
  callsPlaceSlots,
  mediaPlaySlots,
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
  tasksCompleteSlots,
  tasksListSlots,
  remindersAtRestSlots,
  remindersScheduledReadSlots,
  remindersLeaveSlots,
  notesSaveSlots,
  notesFindSlots,
  notesDeleteSlots,
  listsAddSlots,
  listsShowSlots,
  listsRemoveSlots,
  listsDeleteSlots,
  memoryRememberSlots,
  memoryForgetSlots,
  portfolioUpdateSlots,
  portfolioShowSlots,
  expensesAddSlots,
  expensesSummarySlots,
  expensesExportSlots,
  remindersCancelSlots,
  remindersCreateSlots,
  remindersListSlots,
  remindersMoveSlots,
  remindersRepeatSlots,
  settingsSetSlots,
  birthdaysUpcomingSlots,
  mailBillsSlots,
  phoneCallsSlots,
  timerSetSlots,
} from '../nlu/slot-schemas.js';

export const TOOL_NAMES = [
  'reminders.create',
  'reminders.list',
  'reminders.cancel',
  'calendar.list_events',
  'calendar.create_event',
  'calendar.move_event',
  'calendar.delete_event',
  'calls.place',
  // Reminders the parser does not know (2026-10-05): recurring (B6), moved
  // (B8), and set by Shabbat and chag times. Agent-only.
  'reminders.repeat',
  'reminders.move',
  'reminders.at_rest',
  // ROADMAP #7 (2026-10-05): a public lookup sent on a schedule.
  'reminders.scheduled_read',
  // ROADMAP #5 (2026-10-06): when to leave for a calendar event.
  'reminders.leave',
  // Phone actions (PLAN §6.20): agent-only, each one an action card.
  'alarm.set',
  'timer.set',
  'nav.go',
  'app.open',
  'settings.set',
  'message.compose',
  // YouTube and YouTube Music (2026-10-01): play by search, in the background or full screen.
  'media.play',
  // Phone reads (PLAN §6.21): agent-only, answered by the phone mid-turn.
  'phone.contacts',
  'phone.notifications',
  'phone.sms',
  // Public data (2026-10-01): weather, the Hebrew calendar, exchange rates, news.
  'info.lookup',
  // Google Tasks (2026-10-01): lists like shopping and to-do.
  'tasks.list',
  'tasks.add',
  'tasks.complete',
  // Gmail (2026-10-01): read, and drafts the user sends.
  'mail.search',
  'mail.draft',
  // Google Drive (2026-10-01): find a file by its name.
  'drive.search',
  // ROADMAP block B (2026-10-05): sums and conversions, and free time.
  'calc.compute',
  'calendar.free_time',
  // ROADMAP block D (2026-10-05): notes, kept from the model, and expenses.
  'notes.save',
  'notes.find',
  'notes.delete',
  'expenses.add',
  'expenses.summary',
  'expenses.export',
  // ROADMAP block E (2026-10-06): birthdays with Google Contacts, bills in
  // Gmail, and the phone's call log.
  'birthdays.upcoming',
  'mail.bills',
  'phone.calls',
  // ROADMAP block H (2026-10-07): named lists, private like notes.
  'lists.add',
  'lists.show',
  'lists.remove',
  'lists.delete',
  // ROADMAP block H part 18 (2026-10-07): facts about the user, which the model sees.
  'memory.remember',
  'memory.forget',
  // ROADMAP block H part 19 (2026-10-08): the stock portfolio, private.
  'portfolio.update',
  'portfolio.show',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The tools the single-shot parser knows (§6.2). The phone actions are agent-
 * only: adding them here would change the parser's prompt and wire schema,
 * which its eval measured as they are.
 */
export const PARSER_TOOL_NAMES = [
  'reminders.create',
  'reminders.list',
  'reminders.cancel',
  'calendar.list_events',
  'calendar.create_event',
  'calendar.move_event',
  'calendar.delete_event',
  'calls.place',
] as const satisfies readonly ToolName[];

/** Tier 4 has no code path and never appears here (CLAUDE.md invariant 6). */
export type Tier = 0 | 1 | 2 | 3;

export type GoogleScope =
  | 'https://www.googleapis.com/auth/calendar.events.owned'
  | 'https://www.googleapis.com/auth/calendar.app.created';

/**
 * A source of the user's data that a smart conversation may read only with the
 * user's consent (2026-10-08).
 */
export type ConsentSource =
  | 'calendar'
  | 'reminders'
  | 'tasks'
  | 'mail'
  | 'drive'
  | 'birthdays'
  | 'contacts'
  | 'sms'
  | 'calls'
  | 'notifications'
  | 'expenses';

/**
 * What a tool's replies may carry: a consent source, `public` for data that is
 * nobody's (or only the user's words from this very message), or `private` for
 * what never reaches any model (notes, lists, the portfolio, facts).
 */
export type DataSource = ConsentSource | 'public' | 'private';

export type ToolSpec = {
  name: ToolName;
  /**
   * The data the tool's replies may carry (2026-10-08): the reply, the resolve
   * outcome, the confirmation card, a list of candidates, the Undo text. Not
   * whether it reads or writes — `reminders.leave` writes a reminder but shows
   * an event's title, so it is `calendar`. Required: a new tool without one does
   * not compile.
   */
  dataSource: DataSource;
  /**
   * Shown to the LLM. Intent only — never data, ids, or examples of the user's
   * content. Kept short on purpose: the whole prompt competes for the free
   * tier's 8K tokens-per-minute budget (PLAN §2).
   */
  llmDescription: string;
  /** The slots the LLM may emit for this tool. Strict; unknown keys are rejected. */
  draftSchema: ZodTypeAny;
  tier: Tier;
  scopes: GoogleScope[];
  rateLimit: { perHour: number; perDay: number };
  /** The phase that gives this tool an executable body. */
  implementedIn: 4 | 5 | 6;
  /**
   * Where a confirmation happens. Absent means in chat: a button, or a typed
   * code at Tier 3. `device` means on the paired phone's own screen, which
   * replaces both and is strictly stronger (PLAN §6.17). `card` means an action
   * card in the app, claimed once by a signed request before the phone runs it
   * (§6.20).
   */
  confirmation?: 'device' | 'card';
  /**
   * A card the app may run without the tap: low-risk, local, reversible on the
   * phone itself. Only on a clean turn, with the chat in the foreground (§6.20).
   */
  autoRun?: true;
  /**
   * A Tier 0 read the paired phone answers (§6.21). Never executed here: the
   * agent's turn waits for the phone, and the result is text someone else wrote.
   */
  phoneRead?: true;
  /**
   * Every reply of this tool is kept from the model (2026-10-05, notes): a read
   * ends the agent's turn instead of returning to it, and the agent's history
   * keeps a placeholder for the exchange. The clarify, the confirmation, the
   * Undo and the button replies are stamped too, not only the execute.
   */
  private?: true;
  /**
   * A Tier 0 read whose code-rendered text is the whole answer: it ends the
   * agent's turn instead of returning to the model (2026-10-05, expense sums —
   * numbers the model-bound scrub would blank anyway).
   */
  terminal?: true;
  /** A card tool offered only to an app that reports this capability (§6.20). */
  needsCap?: 'file';
};

const EVENTS_OWNED: GoogleScope = 'https://www.googleapis.com/auth/calendar.events.owned';

export const REGISTRY: Readonly<Record<ToolName, ToolSpec>> = {
  'reminders.create': {
    name: 'reminders.create',
    dataSource: 'reminders',
    llmDescription: 'Remind the user at a stated time.',
    draftSchema: remindersCreateSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 4,
  },
  'reminders.list': {
    name: 'reminders.list',
    dataSource: 'reminders',
    llmDescription: 'List upcoming reminders.',
    draftSchema: remindersListSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 200 },
    implementedIn: 4,
  },
  'reminders.cancel': {
    name: 'reminders.cancel',
    dataSource: 'reminders',
    llmDescription: 'Cancel a reminder the user describes.',
    draftSchema: remindersCancelSlots,
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 4,
  },
  'reminders.repeat': {
    name: 'reminders.repeat',
    dataSource: 'reminders',
    llmDescription:
      'A repeating reminder at a stated time: every day, on given weekdays (0=Sunday), or a day of the month.',
    draftSchema: remindersRepeatSlots,
    // Like a one-off reminder: the user's own words, to the user, undone in
    // one tap — the Undo ends the whole series.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'reminders.move': {
    name: 'reminders.move',
    dataSource: 'reminders',
    llmDescription: 'Move a pending reminder the user describes to a new day or time.',
    draftSchema: remindersMoveSlots,
    // Found by description, so it is confirmed first, like a cancel.
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
  },
  'reminders.at_rest': {
    name: 'reminders.at_rest',
    dataSource: 'reminders',
    llmDescription:
      'A reminder relative to Shabbat or a chag: minutes before it starts (candle lighting) or after it ends.',
    draftSchema: remindersAtRestSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'reminders.scheduled_read': {
    name: 'reminders.scheduled_read',
    dataSource: 'reminders',
    llmDescription:
      'Send a lookup on a schedule: weather, day times, UV and air, exchange rates, news or the Hebrew calendar, every day, on given weekdays (0=Sunday), or a day of the month, at a stated time.',
    draftSchema: remindersScheduledReadSlots,
    // Like reminders.repeat: the user's own setting, to the user, undone in
    // one tap. At the due time code runs a Tier 0 read; no model is involved.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'reminders.leave': {
    name: 'reminders.leave',
    // It reads the event: its title is in the reply and the Undo (2026-10-08).
    dataSource: 'calendar',
    llmDescription:
      'A reminder to leave for a calendar event: the event by title words (event) or the next one (next_event), and the travel time in minutes if the user said it.',
    draftSchema: remindersLeaveSlots,
    // The user's own reminder, undone in one tap. The time is code's: the
    // event's start minus the travel time (ROADMAP #5).
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'calendar.list_events': {
    name: 'calendar.list_events',
    dataSource: 'calendar',
    llmDescription: 'List calendar events for a day or range.',
    draftSchema: calendarListEventsSlots,
    tier: 0,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 60, perDay: 200 },
    implementedIn: 5,
  },
  'calendar.create_event': {
    name: 'calendar.create_event',
    dataSource: 'calendar',
    llmDescription: 'Schedule a meeting, appointment or call.',
    draftSchema: calendarCreateEventSlots,
    tier: 1,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
  },
  'calendar.move_event': {
    name: 'calendar.move_event',
    dataSource: 'calendar',
    llmDescription: 'Move an existing event to a new time.',
    draftSchema: calendarMoveEventSlots,
    tier: 2,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
  },
  'calendar.delete_event': {
    name: 'calendar.delete_event',
    dataSource: 'calendar',
    llmDescription: 'Delete one event the user describes.',
    draftSchema: calendarDeleteEventSlots,
    tier: 2,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'calls.place': {
    name: 'calls.place',
    // The phone matches a contact; its answer says whether one was found.
    dataSource: 'contacts',
    llmDescription: 'Phone a contact the user names.',
    draftSchema: callsPlaceSlots,
    // Irreversible and external-facing. The tap on the phone, which shows the
    // resolved number, is the Tier 3 factor (§6.17).
    tier: 3,
    scopes: [],
    rateLimit: { perHour: 5, perDay: 20 },
    implementedIn: 6,
    confirmation: 'device',
  },
  'alarm.set': {
    name: 'alarm.set',
    dataSource: 'public',
    llmDescription: 'Set an alarm on the phone at a stated time.',
    draftSchema: alarmSetSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'timer.set': {
    name: 'timer.set',
    dataSource: 'public',
    llmDescription: 'Start a countdown timer on the phone.',
    draftSchema: timerSetSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'nav.go': {
    name: 'nav.go',
    // A destination may be an event's location (`source: 'event'`).
    dataSource: 'calendar',
    llmDescription:
      "Navigate with Waze or Google Maps to a place (destination), a contact's address (contact), or a calendar event's location (event, or next_event for the next one).",
    draftSchema: navGoSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'app.open': {
    name: 'app.open',
    dataSource: 'public',
    llmDescription: 'Open an app installed on the phone.',
    draftSchema: appOpenSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'media.play': {
    name: 'media.play',
    dataSource: 'public',
    llmDescription:
      'Play on the phone. app: youtube_music for a song or music, youtube for a video, spotify only if the user said Spotify; leave it out when unclear. mode: background or fullscreen, only if the user said.',
    draftSchema: mediaPlaySlots,
    // Opens a player on the phone with words to search for; nothing leaves it.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'settings.set': {
    name: 'settings.set',
    dataSource: 'public',
    llmDescription: 'Flashlight, do-not-disturb, ringer mode, or open Wi-Fi/Bluetooth settings.',
    draftSchema: settingsSetSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
    confirmation: 'card',
    // Only the flashlight runs on its own: DND and the ringer could silence the
    // assistant's own reminders, so they always wait for the tap (§6.20).
    autoRun: true,
  },
  'message.compose': {
    name: 'message.compose',
    // The phone matches a contact, as for a call.
    dataSource: 'contacts',
    llmDescription: 'Write an SMS or WhatsApp message to a contact; the user sends it.',
    draftSchema: messageComposeSlots,
    // External-facing. The card shows the whole text; the phone resolves the
    // contact; the user presses send in the messaging app itself (§6.20).
    tier: 3,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 40 },
    implementedIn: 6,
    confirmation: 'card',
  },
  'phone.contacts': {
    name: 'phone.contacts',
    dataSource: 'contacts',
    llmDescription: "Look up names in the phone's contacts (names only, no numbers).",
    draftSchema: phoneContactsSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    phoneRead: true,
  },
  'phone.notifications': {
    name: 'phone.notifications',
    dataSource: 'notifications',
    llmDescription:
      "Read notifications that arrived on the phone from other apps, optionally from one app. Not the reminders the user set: those are reminders.list.",
    draftSchema: phoneNotificationsSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    phoneRead: true,
  },
  'phone.sms': {
    name: 'phone.sms',
    dataSource: 'sms',
    llmDescription: 'Read recent SMS messages on the phone, optionally from one sender.',
    draftSchema: phoneSmsSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    phoneRead: true,
  },
  'info.lookup': {
    name: 'info.lookup',
    dataSource: 'public',
    llmDescription:
      'Look up public data: weather (forecast for a place and day), jewish_calendar (Hebrew date, Shabbat times, parasha, holidays), exchange_rate (Bank of Israel), news (headlines), day_times (dawn, sunrise, sunset, nightfall), uv_air (UV index, air quality), wikipedia (an article; query: what to look up).',
    draftSchema: infoLookupSlots,
    // Reads public data and changes nothing. News, Hebcal titles and Wikipedia
    // are text others wrote: those reads taint the turn (the tool says so per
    // result). A Wikipedia query is refused in a turn already tainted.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'tasks.list': {
    name: 'tasks.list',
    dataSource: 'tasks',
    llmDescription: "Show the user's Google Tasks lists (shopping, to-do), or one list.",
    draftSchema: tasksListSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'tasks.add': {
    name: 'tasks.add',
    dataSource: 'tasks',
    llmDescription: 'Add an item to a Google Tasks list, only when the user says tasks (משימות). A named list like shopping is lists.add.',
    draftSchema: tasksAddSlots,
    // Reversible: the Undo deletes it.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
  },
  'mail.search': {
    name: 'mail.search',
    dataSource: 'mail',
    llmDescription:
      "Search or read the user's Gmail, newest first: by sender, topic, unread. days: how far back (default 30, up to 365). count: how many (1 for 'my last mail', default 6, up to 10). full=true reads the newest match.",
    draftSchema: mailSearchSlots,
    // Read only. Mail is text others wrote: every result taints the turn.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'mail.draft': {
    name: 'mail.draft',
    dataSource: 'mail',
    llmDescription: 'Write a Gmail draft (a reply to a recent mail, or new without a recipient). Never sent; the user sends it.',
    draftSchema: mailDraftSlots,
    // Nothing leaves: a draft waits in Gmail. Still confirmed, with the whole
    // text shown, because its words are the model's.
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'notes.save': {
    name: 'notes.save',
    dataSource: 'private',
    llmDescription: 'Keep a note the user asks to remember ("remember that…"), with no time. text: what to keep, in the user\'s words.',
    draftSchema: notesSaveSlots,
    // The user's own words, kept for them; Undo deletes it. Private: no reply
    // of a notes tool goes back to the model or into its history.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 6,
    private: true,
  },
  'notes.find': {
    name: 'notes.find',
    dataSource: 'private',
    llmDescription:
      "Show the user's notes, or those about what they describe (\"what did I save\", \"my notes\"). Empty query_variants: all. Shown to the user directly: always call it, never answer yourself.",
    draftSchema: notesFindSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
    private: true,
  },
  'notes.delete': {
    name: 'notes.delete',
    dataSource: 'private',
    llmDescription: 'Delete a note the user describes.',
    draftSchema: notesDeleteSlots,
    // Found by description, so it is confirmed first, like a cancel.
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
    private: true,
  },
  'expenses.add': {
    name: 'expenses.add',
    dataSource: 'expenses',
    llmDescription:
      'Record money the user spent, in shekels. amount: the number. category: the closest one (petrol is fuel, a supermarket is groceries). description: a few words, if said. The day only if said: days_ago (1 = yesterday), or weekday, or on_date.',
    draftSchema: expensesAddSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 200 },
    implementedIn: 6,
  },
  'expenses.summary': {
    name: 'expenses.summary',
    dataSource: 'expenses',
    llmDescription: 'How much the user spent in a period; category when the user names what it was on (petrol is fuel). The answer is shown to the user directly.',
    draftSchema: expensesSummarySlots,
    // Sums are numbers the model-bound scrub would blank; code's text is the answer.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
    terminal: true,
  },
  'expenses.export': {
    name: 'expenses.export',
    dataSource: 'expenses',
    llmDescription: 'Export the user\'s expenses to a spreadsheet file (Excel) on the phone.',
    draftSchema: expensesExportSlots,
    // A card: the file is saved on the user's own phone, from the signed claim.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
    needsCap: 'file',
  },
  'drive.search': {
    name: 'drive.search',
    dataSource: 'drive',
    llmDescription: "Find files in the user's Google Drive by name, kind or how recently changed (names and dates only).",
    draftSchema: driveSearchSlots,
    // Read only, names never contents. A shared file's name is someone else's
    // words: the result taints the turn.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
  },
  'tasks.complete': {
    name: 'tasks.complete',
    dataSource: 'tasks',
    llmDescription: 'Mark an item on a Google Tasks list as done.',
    draftSchema: tasksCompleteSlots,
    // Reversible: the Undo opens it again.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
  },
  'calc.compute': {
    name: 'calc.compute',
    dataSource: 'public',
    llmDescription:
      'Compute arithmetic (+ - * / ^ % sqrt) or convert units. expression: digits and operators only. A conversion: expression is just the amount, with from_unit and to_unit; never write a conversion formula.',
    draftSchema: calcComputeSlots,
    // Computes in code and changes nothing.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
  },
  'birthdays.upcoming': {
    name: 'birthdays.upcoming',
    dataSource: 'birthdays',
    llmDescription:
      "Upcoming birthdays (the user's list and Google Contacts), or one person's birthday by name. days: how far ahead (default 30). The answer is shown to the user directly.",
    draftSchema: birthdaysUpcomingSlots,
    // A read. Dates are numbers the model-bound scrub would blank, so code's
    // text is the answer. A name from Google Contacts taints the turn.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
    terminal: true,
  },
  'mail.bills': {
    name: 'mail.bills',
    dataSource: 'mail',
    llmDescription:
      'Bills and invoices to pay, found in Gmail, with the amount and the due date when the mail says them. days: how far back (default 45). The answer is shown to the user directly.',
    draftSchema: mailBillsSlots,
    // Read only. Code builds the query and reads amounts and dates; mail is
    // someone else's words, so the result taints the turn.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    terminal: true,
  },
  // ROADMAP block H (2026-10-07): named lists. Private: no reply goes back to
  // the model or into its history. A list is found in code by its name.
  'lists.add': {
    name: 'lists.add',
    dataSource: 'private',
    llmDescription:
      "Add items to one of the user's named lists (shopping, gifts, ideas). list: its name as said; items: each item. A new name starts a list. Google Tasks only when the user says tasks; shares the user owns are portfolio.update.",
    draftSchema: listsAddSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
    private: true,
  },
  'lists.show': {
    name: 'lists.show',
    dataSource: 'private',
    llmDescription: "Show one of the user's lists, or all of them when none is named. Shown to the user directly: always call it, never answer yourself.",
    draftSchema: listsShowSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
    private: true,
  },
  'lists.remove': {
    name: 'lists.remove',
    dataSource: 'private',
    llmDescription: 'Remove items from a list. items: the items as said.',
    draftSchema: listsRemoveSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 300 },
    implementedIn: 6,
    private: true,
  },
  'lists.delete': {
    name: 'lists.delete',
    dataSource: 'private',
    llmDescription: 'Delete a whole list.',
    draftSchema: listsDeleteSlots,
    // A whole list in one step: confirmed first, like a note's deletion.
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 50 },
    implementedIn: 6,
    private: true,
  },
  // Facts about the user (block H part 18). NOT private: the model sees them on
  // every turn, by the user's decision. Saved only on an explicit signal.
  'memory.remember': {
    name: 'memory.remember',
    dataSource: 'private',
    llmDescription:
      'Keep a lasting fact about the user, only when they say to remember it about them ("תזכור עליי", "על עצמי", "תזכור לתמיד", "remember about me"): where they live, preferences, family. Plain "remember that…" is notes.save. text: the fact, in their words.',
    draftSchema: memoryRememberSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 50 },
    implementedIn: 6,
  },
  'memory.forget': {
    name: 'memory.forget',
    dataSource: 'private',
    llmDescription: 'Forget a fact about the user that they describe.',
    draftSchema: memoryForgetSlots,
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 50 },
    implementedIn: 6,
  },
  // The stock portfolio (block H part 19). Private: no holding or price goes
  // back to the model. The symbol is checked with the quote source in code.
  'portfolio.update': {
    name: 'portfolio.update',
    dataSource: 'private',
    llmDescription:
      'A stock the user holds. op: set ("יש לי"), add ("קניתי", "תוסיף", "עוד"), reduce ("מכרתי"). symbol: the ticker (אפל→AAPL, טבע→TEVA, לאומי→LUMI). Prices per share; market, buy_price, buy_price_unit (שקל/אגורות) only if said.',
    draftSchema: portfolioUpdateSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
    private: true,
  },
  'portfolio.show': {
    name: 'portfolio.show',
    dataSource: 'private',
    llmDescription:
      "The user's stock portfolio: prices, value, gain or loss. Shown to the user directly: always call it.",
    draftSchema: portfolioShowSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
    private: true,
  },
  'phone.calls': {
    name: 'phone.calls',
    dataSource: 'calls',
    llmDescription: "Read the phone's recent calls (names, no numbers): who called, missed calls, or calls with one person.",
    draftSchema: phoneCallsSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    phoneRead: true,
  },
  'calendar.free_time': {
    name: 'calendar.free_time',
    dataSource: 'calendar',
    llmDescription: 'Find free time in the calendar on a day or range. minutes: the shortest gap wanted, if said.',
    draftSchema: calendarFreeTimeSlots,
    // A read. Times only, never titles, so it does not taint the turn.
    tier: 0,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
  },
};

/** What the LLM is told about a tool. Deliberately narrower than `ToolSpec`. */
export type ToolCatalogEntry = {
  name: ToolName;
  description: string;
  /** Slot names, for programmatic use. */
  slots: string[];
  /** `name: type` per slot, so the model knows the allowed values for enums. */
  slotTypes: string[];
};

/**
 * The catalog handed to the NLU provider. Tiers, scopes, rate limits and
 * anything else policy-bearing stay out: the model has no business knowing what
 * is cheap to run or what needs confirming.
 */
export function toolCatalog(enabled: readonly ToolName[] = PARSER_TOOL_NAMES): ToolCatalogEntry[] {
  return enabled.map((name) => {
    const spec = REGISTRY[name];
    return {
      name: spec.name,
      description: spec.llmDescription,
      slots: slotNamesOf(spec.draftSchema),
      slotTypes: slotTypesOf(spec.draftSchema),
    };
  });
}

export function tierOf(name: ToolName): Tier {
  return REGISTRY[name].tier;
}

export function dataSourceOf(name: ToolName): DataSource {
  return REGISTRY[name].dataSource;
}

export function scopesOf(name: ToolName): GoogleScope[] {
  return REGISTRY[name].scopes;
}

function slotNamesOf(schema: ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * Describe each slot's type for the prompt.
 *
 * Without this the model sees bare slot names and has to guess what a `range`
 * or a `duration_minutes` accepts — which it does, wrongly, and the draft is
 * then rejected by the schema. Deriving the description from the Zod schema
 * keeps the prompt and the validator from ever disagreeing.
 */
function slotTypesOf(schema: ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, ZodTypeAny> }).shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => `${name}: ${describe(field)}`);
}

type ZodInternals = {
  _def?: {
    typeName?: string;
    values?: readonly string[];
    innerType?: ZodTypeAny;
    type?: ZodTypeAny;
    options?: readonly ZodTypeAny[];
    checks?: { kind: string; value: number }[];
  };
};

function describe(field: ZodTypeAny): string {
  const def = (field as ZodInternals)._def;
  if (!def) return 'value';

  switch (def.typeName) {
    case 'ZodOptional':
      return def.innerType ? `${describe(def.innerType)}?` : 'value?';
    case 'ZodDefault':
      return def.innerType ? describe(def.innerType) : 'value';
    case 'ZodEnum':
      return (def.values ?? []).map((v) => `"${v}"`).join('|');
    case 'ZodArray':
      return def.type ? `${describe(def.type)}[]` : 'value[]';
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'int';
    case 'ZodDiscriminatedUnion':
      // The only discriminated unions in a slot position are the date shapes,
      // which the prompt spells out in full.
      return 'DateSpec';
    case 'ZodObject':
      return 'TimeSpec';
    default:
      return 'value';
  }
}
