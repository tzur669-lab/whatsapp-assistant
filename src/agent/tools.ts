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

type Def = { typeName?: string; innerType?: ZodTypeAny; values?: readonly string[] };

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
      return { type: 'array', items: { type: 'string' } };
    case 'ZodNumber':
      return { type: 'integer' };
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
 * The tools offered on a channel. Phase A offers the registry's server tools on
 * both; phone tools join in Phases B and C, gated by what the device declared.
 */
export function agentToolNames(): ToolName[] {
  return [...TOOL_NAMES];
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
 * invitations and subscribed feeds; reminders are the user's own words.
 */
export const TAINTING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['calendar.list_events']);
