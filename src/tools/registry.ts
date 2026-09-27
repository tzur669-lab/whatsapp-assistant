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
  calendarCreateEventSlots,
  calendarDeleteEventSlots,
  calendarListEventsSlots,
  calendarMoveEventSlots,
  callsPlaceSlots,
  remindersCancelSlots,
  remindersCreateSlots,
  remindersListSlots,
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

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
   * replaces both and is strictly stronger (PLAN §6.17).
   */
  confirmation?: 'device';
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
export function toolCatalog(enabled: readonly ToolName[] = TOOL_NAMES): ToolCatalogEntry[] {
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
