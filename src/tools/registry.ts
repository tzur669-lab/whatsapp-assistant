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
  tasksCompleteSlots,
  tasksListSlots,
  remindersCancelSlots,
  remindersCreateSlots,
  remindersListSlots,
  settingsSetSlots,
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
  // Phone actions (PLAN §6.20): agent-only, each one an action card.
  'alarm.set',
  'timer.set',
  'nav.go',
  'app.open',
  'settings.set',
  'message.compose',
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

export type ToolSpec = {
  name: ToolName;
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
};

const EVENTS_OWNED: GoogleScope = 'https://www.googleapis.com/auth/calendar.events.owned';

export const REGISTRY: Readonly<Record<ToolName, ToolSpec>> = {
  'reminders.create': {
    name: 'reminders.create',
    llmDescription: 'Remind the user at a stated time.',
    draftSchema: remindersCreateSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 4,
  },
  'reminders.list': {
    name: 'reminders.list',
    llmDescription: 'List upcoming reminders.',
    draftSchema: remindersListSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 60, perDay: 200 },
    implementedIn: 4,
  },
  'reminders.cancel': {
    name: 'reminders.cancel',
    llmDescription: 'Cancel a reminder the user describes.',
    draftSchema: remindersCancelSlots,
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 4,
  },
  'calendar.list_events': {
    name: 'calendar.list_events',
    llmDescription: 'List calendar events for a day or range.',
    draftSchema: calendarListEventsSlots,
    tier: 0,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 60, perDay: 200 },
    implementedIn: 5,
  },
  'calendar.create_event': {
    name: 'calendar.create_event',
    llmDescription: 'Schedule a meeting, appointment or call.',
    draftSchema: calendarCreateEventSlots,
    tier: 1,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
  },
  'calendar.move_event': {
    name: 'calendar.move_event',
    llmDescription: 'Move an existing event to a new time.',
    draftSchema: calendarMoveEventSlots,
    tier: 2,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 20, perDay: 60 },
    implementedIn: 6,
  },
  'calendar.delete_event': {
    name: 'calendar.delete_event',
    llmDescription: 'Delete one event the user describes.',
    draftSchema: calendarDeleteEventSlots,
    tier: 2,
    scopes: [EVENTS_OWNED],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'calls.place': {
    name: 'calls.place',
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
    llmDescription: 'Navigate to a place with Waze or Google Maps.',
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
    llmDescription: 'Open an app installed on the phone.',
    draftSchema: appOpenSlots,
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 100 },
    implementedIn: 6,
    confirmation: 'card',
    autoRun: true,
  },
  'settings.set': {
    name: 'settings.set',
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
    llmDescription: "Read the phone's recent notifications, optionally from one app.",
    draftSchema: phoneNotificationsSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 20, perDay: 100 },
    implementedIn: 6,
    phoneRead: true,
  },
  'phone.sms': {
    name: 'phone.sms',
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
    llmDescription:
      'Look up public data: weather (forecast for a place and day), jewish_calendar (Hebrew date, Shabbat times, parasha, holidays), exchange_rate (Bank of Israel), news (headlines).',
    draftSchema: infoLookupSlots,
    // Reads public data and changes nothing. News and Hebcal titles are text
    // others wrote: those reads taint the turn (the tool says so per result).
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'tasks.list': {
    name: 'tasks.list',
    llmDescription: "Show the user's Google Tasks lists (shopping, to-do), or one list.",
    draftSchema: tasksListSlots,
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'tasks.add': {
    name: 'tasks.add',
    llmDescription: 'Add an item to a Google Tasks list (e.g. shopping); not for timed reminders.',
    draftSchema: tasksAddSlots,
    // Reversible: the Undo deletes it.
    tier: 1,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 150 },
    implementedIn: 6,
  },
  'mail.search': {
    name: 'mail.search',
    llmDescription: "Search or read the user's recent Gmail: by sender, topic, unread; full=true reads the newest match.",
    draftSchema: mailSearchSlots,
    // Read only. Mail is text others wrote: every result taints the turn.
    tier: 0,
    scopes: [],
    rateLimit: { perHour: 30, perDay: 200 },
    implementedIn: 6,
  },
  'mail.draft': {
    name: 'mail.draft',
    llmDescription: 'Write a Gmail draft (a reply to a recent mail, or new without a recipient). Never sent; the user sends it.',
    draftSchema: mailDraftSlots,
    // Nothing leaves: a draft waits in Gmail. Still confirmed, with the whole
    // text shown, because its words are the model's.
    tier: 2,
    scopes: [],
    rateLimit: { perHour: 10, perDay: 30 },
    implementedIn: 6,
  },
  'drive.search': {
    name: 'drive.search',
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
    llmDescription: 'Mark an item on a Google Tasks list as done.',
    draftSchema: tasksCompleteSlots,
    // Reversible: the Undo opens it again.
    tier: 1,
    scopes: [],
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
