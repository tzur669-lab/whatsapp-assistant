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
import { REGISTRY, TOOL_NAMES } from '../tools/registry.js';
import type { ToolName } from '../tools/registry.js';
import type { WireTool } from './provider.js';

type Def = { typeName?: string; innerType?: ZodTypeAny; type?: ZodTypeAny; values?: readonly string[] };

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
      return { type: 'integer' };
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
  'phone.contacts',
  'phone.notifications',
  'phone.sms',
  // A task made from a Gmail message carries its subject: someone else's words.
  'tasks.list',
  // Mail is the plainest case of text someone else wrote.
  'mail.search',
  // A shared file's name was chosen by whoever shared it.
  'drive.search',
]);
