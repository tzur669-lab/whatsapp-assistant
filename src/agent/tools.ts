/**
 * The agent's tool catalog, generated from the registry (PLAN §6.19).
 *
 * Compact on purpose. The full strict JSON Schema of the eight tools measured
 * 13.7K characters — about 4,900 prompt tokens on qwen — so two calls could not
 * fit one minute of the free tier (spike, 2026-10-01). Here each slot names only
 * its type, and `DateSpec`/`TimeSpec` are spelled out once in the system prompt.
 * That is a description, not the guarantee: every argument still passes the
 * tool's strict Zod schema before anything runs (invariant 3).
 *
 * Wire names use `__` for the dot, which function names may not contain.
 */
import type { ZodTypeAny } from 'zod';
import { timeSpecSchema } from '../nlu/slot-schemas.js';
import { timeWordsNamed } from '../time/hebrew-lexicon.js';
import { dataSourceOf, REGISTRY, TOOL_NAMES } from '../tools/registry.js';
import type { ConsentSource, ToolName } from '../tools/registry.js';
import type { AgentMessage, WireTool } from './provider.js';

type Def = { typeName?: string; innerType?: ZodTypeAny; type?: ZodTypeAny; values?: readonly string[]; checks?: readonly { kind: string }[] };

function compactSlot(field: ZodTypeAny): Record<string, unknown> {
  const def = (field as unknown as { _def: Def })._def;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
      return def.innerType ? compactSlot(def.innerType) : { type: 'string' };
    case 'ZodDiscriminatedUnion':
      return { type: 'object', description: 'DateSpec' };
    case 'ZodObject':
      return { type: 'object', description: 'TimeSpec' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values ?? [])] };
    case 'ZodArray':
      // Items as declared: `weekdays` is numbers, `query_variants` strings.
      return { type: 'array', items: def.type ? compactSlot(def.type) : { type: 'string' } };
    case 'ZodNumber':
      // Whole numbers only where the schema says so, as on the parser's wire:
      // a share price or an amount may have agorot (2026-10-08).
      return { type: (def.checks ?? []).some((check) => check.kind === 'int') ? 'integer' : 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    default:
      return { type: 'string' };
  }
}

export function toWireName(name: ToolName): string {
  return name.replace('.', '__');
}

/** The registry name for a wire name, or null for anything the catalog never offered. */
export function fromWireName(wire: string, offered: readonly ToolName[]): ToolName | null {
  const name = wire.replace('__', '.');
  return (offered as readonly string[]).includes(name) ? (name as ToolName) : null;
}

/** Each tool's TimeSpec slots, found by schema identity: `time`, `from_time`, `to_time`. */
const TIME_SLOTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  TOOL_NAMES.map((name) => {
    const shape = (REGISTRY[name].draftSchema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const slots = Object.entries(shape)
      .filter(([, field]) => {
        const def = (field as unknown as { _def: Def })._def;
        return field === timeSpecSchema || def.innerType === timeSpecSchema;
      })
      .map(([slot]) => slot);
    return [name, slots];
  }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A TimeSpec sent without `meridiem` or `part_of_day` (2026-10-08). The catalog
 * names a TimeSpec only as an object, and Gemini sent `{"hour":8,"minute":0}`
 * for 6 of 19 tool calls in one eval, each rejected by strict Zod. A missing
 * key is filled with 'unspecified' — the value that already means "not stated"
 * — only where that cannot change the time (invariant 4):
 *
 *   - only when `hour` and `minute` are both numbers: a missing time, hour or
 *     minute is never made up, and stays a rejection or a CLARIFY;
 *   - never over a key that was sent;
 *   - `meridiem` when the hour is 13–23, which no am/pm moves, or when nothing
 *     in the conversation (`said`: the user's words, this turn and the history)
 *     names am or pm;
 *   - `part_of_day` when the hour is 13–23, when a sent am/pm decides alone
 *     (`applyMeridiem` and R5 never read `part_of_day` then), or when nothing
 *     said names a part of the day.
 *
 * Otherwise the key stays missing and strict Zod rejects the call, as before:
 * "8 בערב" sent as `{"hour":8,"minute":0}` never becomes 08:00. What a filled
 * call resolves to is what an explicit 'unspecified' resolves to (R4 reads a
 * bare 1–12 hour on the 24-hour clock; R5 asks about 00–05). Agent tool calls
 * only; the parser's strict structured output always sends both keys. Never
 * mutates its input.
 */
export function fillUnstatedTime(tool: string, args: unknown, said: string): unknown {
  if (!isRecord(args)) return args;
  let out: Record<string, unknown> | null = null;
  let named: { meridiem: boolean; partOfDay: boolean } | null = null;
  for (const slot of TIME_SLOTS[tool] ?? []) {
    const time = args[slot];
    if (!isRecord(time) || typeof time['hour'] !== 'number' || typeof time['minute'] !== 'number') continue;
    const noMeridiem = time['meridiem'] === undefined;
    const noPart = time['part_of_day'] === undefined;
    if (!noMeridiem && !noPart) continue;

    named ??= timeWordsNamed(said);
    const lateHour = time['hour'] >= 13 && time['hour'] <= 23;
    const statedMeridiem = time['meridiem'] === 'am' || time['meridiem'] === 'pm';
    const fillMeridiem = noMeridiem && (lateHour || !named.meridiem);
    const fillPart = noPart && (lateHour || statedMeridiem || !named.partOfDay);
    if (!fillMeridiem && !fillPart) continue;

    out ??= { ...args };
    out[slot] = {
      ...time,
      ...(fillMeridiem ? { meridiem: 'unspecified' } : {}),
      ...(fillPart ? { part_of_day: 'unspecified' } : {}),
    };
  }
  return out ?? args;
}

/**
 * What `fillUnstatedTime` checks for am/pm and parts of the day: every message
 * of the turn but the system prompt — the user's words now and in the history,
 * the replies, read results. Wide on purpose: a word found anywhere only keeps
 * the rejection.
 */
export function conversationText(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => message.content ?? '')
    .join('\n');
}

/**
 * The tools offered on a turn. The server tools always; the phone actions only
 * when the turn came from an app that declared it runs cards (§6.20) — offered
 * anywhere else, a card would wait for a phone that cannot run it. The phone
 * reads only when the app declared it answers them, and only on a typed
 * message: a suspended turn stores the message, and a transcript is never
 * stored (§6.21, invariant 13).
 */
export type OfferOptions = {
  cards: boolean;
  /** The app saves a file a card carries (2026-10-05, the expenses export). */
  fileCards?: boolean;
  phoneReads?: boolean;
  /**
   * The Google grants that are connected (2026-10-01). A tool for a grant that
   * is not is left out: every offered tool is prompt tokens on every call, and
   * a grant not connected is the common case.
   */
  grants?: { gmail?: boolean; tasks?: boolean; drive?: boolean };
  /**
   * The fallback model's turn (2026-10-05): Tier 0 reads that answer here and
   * now, nothing else — no write, no card, no phone read.
   */
  readOnly?: boolean;
};

export function agentToolNames(options: OfferOptions = { cards: false }): ToolName[] {
  return TOOL_NAMES.filter((name) => {
    const spec = REGISTRY[name];
    if (options.readOnly && (spec.tier !== 0 || spec.phoneRead || spec.confirmation === 'card')) return false;
    if (name.startsWith('mail.')) return options.grants?.gmail === true;
    if (name.startsWith('tasks.')) return options.grants?.tasks === true;
    if (name.startsWith('drive.')) return options.grants?.drive === true;
    if (spec.needsCap === 'file') return options.cards && options.fileCards === true;
    if (spec.confirmation === 'card') return options.cards;
    if (spec.phoneRead) return options.phoneReads === true;
    return true;
  });
}

/**
 * What a smart conversation may be offered, on any model (smart conversations,
 * 2026-10-08), of what the turn would be offered anyway: the public tools, the
 * tools of the sources the conversation allowed (`granted`), and — when the
 * turn may ask (`ask`: the conversation's own typed words) — the tools of
 * every other consent source, whose call pauses the turn for the user's
 * consent instead of running (slice 5). Never a private tool: notes, lists,
 * the portfolio and facts reach no smart conversation. Consent belongs to the
 * conversation, not the model, so qwen and the read-only try in a smart
 * conversation get the same set. Without options: public only.
 */
export function smartOfferedTools(
  offered: readonly ToolName[],
  consent: { granted: readonly ConsentSource[]; ask: boolean } = { granted: [], ask: false },
): ToolName[] {
  return offered.filter((name) => {
    const source = dataSourceOf(name);
    if (source === 'public') return true;
    if (source === 'private') return false;
    return consent.ask || consent.granted.includes(source);
  });
}

export function wireTools(names: readonly ToolName[]): WireTool[] {
  return names.map((name) => {
    const spec = REGISTRY[name];
    const shape = (spec.draftSchema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    return {
      type: 'function',
      function: {
        name: toWireName(name),
        description: spec.llmDescription,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(shape).map(([slot, field]) => [slot, compactSlot(field)]),
          ),
        },
      },
    };
  });
}

/**
 * Read tools whose results carry text someone else wrote. A calendar holds
 * invitations and subscribed feeds; reminders are the user's own words. Every
 * phone read does: SMS and notifications are other people's words, and contact
 * names arrive from synced accounts as often as from the user (§6.21).
 */
export const TAINTING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'calendar.list_events',
  // Their confirmation card names the event found, and several matches come
  // back as a list of titles: an invitation's words (2026-10-08).
  'calendar.move_event',
  'calendar.delete_event',
  'phone.contacts',
  'phone.notifications',
  'phone.sms',
  // A task made from a Gmail message carries its subject: someone else's words.
  'tasks.list',
  // Mail is the plainest case of text someone else wrote.
  'mail.search',
  'mail.bills',
  // Callers' names come from the phone's contacts, like an SMS sender's (2026-10-06).
  'phone.calls',
  // A shared file's name was chosen by whoever shared it.
  'drive.search',
]);
