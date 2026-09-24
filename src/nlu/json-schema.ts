/**
 * Zod -> JSON Schema, for the provider's structured-output mode (PLAN §6.2).
 *
 * Constraining generation is cheaper and more reliable than asking the model to
 * behave: it cannot emit an unknown slot name, an enum value outside the set, or
 * a malformed date shape in the first place. Measured against `gpt-oss-20b`,
 * unconstrained generation produced 19 schema rejections in 156 cases.
 *
 * Three properties of Groq's implementation shape everything here, all verified
 * against the live API on 2026-09-24:
 *
 *   1. The root must be `type: "object"` — `anyOf` at the top level is refused.
 *      So the response schema is flat: one `slots` object holding the union of
 *      every tool's slots. Nested `anyOf` (DateSpec) is fine.
 *   2. `strict: false` does NOT enforce the schema. Asked for `reminders.list`
 *      with no range, a model returned `range: "unspecified"` — a value absent
 *      from the enum. Non-strict is a hint, not a constraint.
 *   3. `strict: true` DOES enforce it, but requires every property to appear in
 *      `required`. An absent slot is therefore expressed as `null`, not as an
 *      omitted key, and `stripNulls` reconciles that with Zod on the way back.
 *
 * Together those mean: strict mode, everything required, optional things
 * nullable. This is still a narrowing, not a replacement — the Zod `IntentDraft`
 * schema runs on the result and is what enforces per-intent slot combinations
 * (CLAUDE.md invariant 3). Generation constraints are a convenience;
 * validation is the guarantee.
 *
 * Only the Zod constructs used by `slot-schemas.ts` are handled. An unsupported
 * one throws rather than silently emitting a schema that permits more than Zod.
 */
import type { ZodTypeAny } from 'zod';
import { REGISTRY, TOOL_NAMES } from '../tools/registry.js';
import { MAX_AMBIGUITIES, MAX_MISSING_SLOTS, MAX_NOTE_CHARS } from './intent-schema.js';

export type JsonSchema = Record<string, unknown>;

type ZodDef = {
  typeName?: string;
  values?: readonly (string | number)[];
  value?: unknown;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  options?: readonly ZodTypeAny[] | Map<string, ZodTypeAny>;
  checks?: { kind: string; value?: number }[];
  shape?: () => Record<string, ZodTypeAny>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
};

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

export class UnsupportedZodType extends Error {
  constructor(typeName: string | undefined) {
    super(`json-schema: unsupported Zod type "${typeName ?? 'unknown'}"`);
    this.name = 'UnsupportedZodType';
  }
}

/**
 * Convert one Zod schema.
 *
 * `nullable` adds `null` as a permitted value — how strict mode expresses "this
 * key must be present, but the model has nothing to put in it".
 */
export function toJsonSchema(schema: ZodTypeAny, nullable = false): JsonSchema {
  const def = defOf(schema);

  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
      return toJsonSchema(def.innerType as ZodTypeAny, nullable);

    case 'ZodString': {
      const out: JsonSchema = { type: withNull('string', nullable) };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min' && check.value !== undefined) out['minLength'] = check.value;
        if (check.kind === 'max' && check.value !== undefined) out['maxLength'] = check.value;
      }
      return out;
    }

    case 'ZodNumber': {
      const checks = def.checks ?? [];
      const base = checks.some((c) => c.kind === 'int') ? 'integer' : 'number';
      const out: JsonSchema = { type: withNull(base, nullable) };
      for (const check of checks) {
        if (check.kind === 'min' && check.value !== undefined) out['minimum'] = check.value;
        if (check.kind === 'max' && check.value !== undefined) out['maximum'] = check.value;
      }
      return out;
    }

    case 'ZodEnum': {
      const values = [...(def.values ?? [])];
      return {
        type: withNull('string', nullable),
        enum: nullable ? [...values, null] : values,
      };
    }

    case 'ZodLiteral': {
      const base = typeof def.value === 'number' ? 'integer' : 'string';
      return { type: withNull(base, nullable), enum: nullable ? [def.value, null] : [def.value] };
    }

    case 'ZodArray': {
      const out: JsonSchema = {
        type: withNull('array', nullable),
        items: toJsonSchema(def.type as ZodTypeAny),
      };
      if (def.minLength) out['minItems'] = def.minLength.value;
      if (def.maxLength) out['maxItems'] = def.maxLength.value;
      return out;
    }

    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: JsonSchema = {};

      // Strict mode requires every property in `required`, so an optional field
      // becomes a required nullable one instead of being left out.
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = toJsonSchema(field, isOptional(field));
      }

      const object: JsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties,
        required: Object.keys(shape),
      };
      return nullable ? { anyOf: [object, { type: 'null' }] } : object;
    }

    case 'ZodDiscriminatedUnion':
    case 'ZodUnion': {
      const options = def.options;
      const list = options instanceof Map ? [...options.values()] : [...(options ?? [])];
      const branches = list.map((option) => toJsonSchema(option));
      return { anyOf: nullable ? [...branches, { type: 'null' }] : branches };
    }

    default:
      throw new UnsupportedZodType(def.typeName);
  }
}

function withNull(type: string, nullable: boolean): string | string[] {
  return nullable ? [type, 'null'] : type;
}

function isOptional(schema: ZodTypeAny): boolean {
  const typeName = defOf(schema).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

/**
 * The response schema handed to the provider.
 *
 * `slots` is the union of every tool's slots, because the root cannot be a
 * union. That is looser than the Zod schema, which pins slots per intent —
 * deliberately so. The purpose here is to stop the model inventing slot names
 * and enum values; deciding that `query_variants` has no business on a
 * `reminders.create` draft stays with Zod.
 */
export function buildResponseSchema(enabled: readonly string[] = TOOL_NAMES): JsonSchema {
  const slotProperties: JsonSchema = {};

  for (const name of enabled) {
    const spec = REGISTRY[name as (typeof TOOL_NAMES)[number]];
    if (!spec) continue;
    const shape = defOf(spec.draftSchema).shape?.() ?? {};
    for (const [slot, field] of Object.entries(shape)) {
      // Every slot is nullable: any of them can be absent from a given message,
      // whatever the tool's own schema says about it.
      slotProperties[slot] ??= toJsonSchema(field, true);
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'language', 'slots', 'missing', 'ambiguities'],
    properties: {
      intent: { type: 'string', enum: [...enabled, 'unsupported'] },
      language: { type: 'string', enum: ['he', 'en'] },
      slots: {
        type: 'object',
        additionalProperties: false,
        properties: slotProperties,
        required: Object.keys(slotProperties),
      },
      missing: {
        type: 'array',
        maxItems: MAX_MISSING_SLOTS,
        items: { type: 'string', maxLength: 40 },
      },
      ambiguities: {
        type: 'array',
        maxItems: MAX_AMBIGUITIES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'note'],
          properties: {
            slot: { type: 'string', maxLength: 40 },
            note: { type: 'string', maxLength: MAX_NOTE_CHARS },
          },
        },
      },
    },
  };
}

/**
 * Drop `null` values before validation.
 *
 * Strict structured output requires every key to be present, so an absent slot
 * arrives as `null`. Zod models absence as an omitted key. Both mean the same
 * thing, and this is where they are reconciled.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === null) continue;
    out[key] = stripNulls(inner);
  }
  return out;
}
