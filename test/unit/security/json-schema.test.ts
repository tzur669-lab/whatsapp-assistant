/**
 * The generated JSON Schema must never permit more than Zod does. It may
 * permit less — Zod is the guarantee, generation constraints are the
 * convenience — but a schema that allows something Zod rejects would push
 * failures from generation time to validation time, which is the problem it
 * exists to solve.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildResponseSchema,
  stripNulls,
  toJsonSchema,
  UnsupportedZodType,
} from '../../../src/nlu/json-schema.js';
import { dateSpecSchema, timeSpecSchema, rangeSchema } from '../../../src/nlu/slot-schemas.js';
import { validateIntentDraft } from '../../../src/nlu/intent-schema.js';
import { PARSER_TOOL_NAMES } from '../../../src/tools/registry.js';

describe('toJsonSchema', () => {
  it('converts a capped string', () => {
    expect(toJsonSchema(z.string().min(1).max(200))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
  });

  it('converts a bounded integer', () => {
    expect(toJsonSchema(z.number().int().min(0).max(23))).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 23,
    });
  });

  it('converts an enum to a closed list', () => {
    expect(toJsonSchema(rangeSchema)).toEqual({
      type: 'string',
      enum: ['this_week', 'next_week', 'weekend'],
    });
  });

  it('admits null in both the type and the enum when nullable', () => {
    expect(toJsonSchema(rangeSchema, true)).toEqual({
      type: ['string', 'null'],
      enum: ['this_week', 'next_week', 'weekend', null],
    });
  });

  it('offers null as a union branch for a nullable date', () => {
    const branches = toJsonSchema(dateSpecSchema, true)['anyOf'] as Record<string, unknown>[];
    expect(branches).toHaveLength(5);
    expect(branches.at(-1)).toEqual({ type: 'null' });
  });

  it('converts a bounded array', () => {
    expect(toJsonSchema(z.array(z.string().max(100)).min(1).max(5))).toEqual({
      type: 'array',
      items: { type: 'string', maxLength: 100 },
      minItems: 1,
      maxItems: 5,
    });
  });

  it('requires every property and makes the optional ones nullable', () => {
    // Groq's strict mode rejects a schema whose `required` omits a property, so
    // optionality is expressed as a nullable type instead.
    const schema = toJsonSchema(z.object({ a: z.string(), b: z.string().optional() }).strict());
    expect(schema['required']).toEqual(['a', 'b']);
    expect(schema['additionalProperties']).toBe(false);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['a']?.['type']).toBe('string');
    expect(props['b']?.['type']).toEqual(['string', 'null']);
  });

  it('converts a discriminated union to anyOf', () => {
    const schema = toJsonSchema(dateSpecSchema);
    expect(Array.isArray(schema['anyOf'])).toBe(true);
    expect((schema['anyOf'] as unknown[]).length).toBe(4);
  });

  it('pins TimeSpec enums', () => {
    const props = toJsonSchema(timeSpecSchema)['properties'] as Record<string, Record<string, unknown>>;
    expect(props['meridiem']?.['enum']).toEqual(['am', 'pm', 'unspecified']);
    expect(props['hour']).toEqual({ type: 'integer', minimum: 0, maximum: 23 });
  });

  it('throws rather than guessing at an unsupported construct', () => {
    expect(() => toJsonSchema(z.map(z.string(), z.string()))).toThrow(UnsupportedZodType);
  });
});

describe('buildResponseSchema', () => {
  const schema = buildResponseSchema();
  const props = schema['properties'] as Record<string, Record<string, unknown>>;

  it('has an object root — a union root is refused by the provider', () => {
    expect(schema['type']).toBe('object');
    expect(schema['anyOf']).toBeUndefined();
  });

  it('closes the intent enum over the parser\'s tools plus unsupported', () => {
    // The phone actions are agent-only (§6.20): the parser's wire schema is
    // byte-for-byte what its eval measured.
    expect(props['intent']?.['enum']).toEqual([...PARSER_TOOL_NAMES, 'unsupported']);
  });

  it('closes the slots object so an invented slot name cannot be generated', () => {
    const slots = props['slots'] as Record<string, unknown>;
    expect(slots['additionalProperties']).toBe(false);
    const names = Object.keys(slots['properties'] as Record<string, unknown>);
    expect(names).toContain('query_variants');
    expect(names).toContain('duration_minutes');
    expect(names).not.toContain('event_id');
  });

  it('carries every slot from every enabled tool', () => {
    const names = Object.keys(
      (props['slots'] as Record<string, unknown>)['properties'] as Record<string, unknown>,
    );
    for (const slot of ['text', 'title', 'date', 'time', 'range', 'from_date', 'to_time', 'attendees']) {
      expect(names).toContain(slot);
    }
  });

  it('narrows with the enabled tool list', () => {
    const narrowed = buildResponseSchema(['reminders.list']);
    const slots = (narrowed['properties'] as Record<string, Record<string, unknown>>)['slots'];
    expect(Object.keys(slots?.['properties'] as Record<string, unknown>)).toEqual(['range']);
  });

  it('lists every slot in required, as strict mode demands', () => {
    const slots = props['slots'] as Record<string, unknown>;
    const names = Object.keys(slots['properties'] as Record<string, unknown>);
    expect(slots['required']).toEqual(names);
  });

  it('makes every slot nullable, since any of them can be absent', () => {
    const slotProps = (props['slots'] as Record<string, unknown>)['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    for (const [name, schema] of Object.entries(slotProps)) {
      const type = schema['type'];
      const admitsNull =
        (Array.isArray(type) && type.includes('null')) ||
        (schema['anyOf'] as Record<string, unknown>[] | undefined)?.some((b) => b['type'] === 'null');
      expect(admitsNull, `slot ${name} must admit null`).toBe(true);
    }
  });
});

describe('stripNulls', () => {
  it('removes a null slot the model emitted for an absent value', () => {
    expect(stripNulls({ intent: 'reminders.list', slots: { range: null } })).toEqual({
      intent: 'reminders.list',
      slots: {},
    });
  });

  it('removes nulls at every depth', () => {
    expect(stripNulls({ slots: { date: { kind: 'absolute', day: 3, month: 10, year: null } } })).toEqual({
      slots: { date: { kind: 'absolute', day: 3, month: 10 } },
    });
  });

  it('leaves real values alone, including empty arrays and zero', () => {
    expect(stripNulls({ missing: [], offset: 0, text: '' })).toEqual({
      missing: [],
      offset: 0,
      text: '',
    });
  });

  it('turns a null-padded draft into one Zod accepts', () => {
    const fromModel = {
      intent: 'reminders.create',
      language: 'he',
      slots: {
        text: 'להתקשר לאבא',
        date: { kind: 'relative_days', offset: 1 },
        time: null,
        title: null,
        range: null,
      },
      missing: ['time'],
      ambiguities: [],
    };
    expect(validateIntentDraft(fromModel).ok).toBe(false);
    expect(validateIntentDraft(stripNulls(fromModel)).ok).toBe(true);
  });
});

describe('the generated schema never permits more than Zod', () => {
  // Each of these is rejected by Zod; the JSON Schema must reject it too, so
  // the model cannot be steered into producing it.
  const schema = buildResponseSchema();
  const props = schema['properties'] as Record<string, Record<string, unknown>>;

  it('cannot generate an intent outside the registry', () => {
    expect(props['intent']?.['enum']).not.toContain('system.exec');
    expect(validateIntentDraft({ intent: 'system.exec', language: 'he', slots: {} }).ok).toBe(false);
  });

  it('cannot generate an id-bearing slot', () => {
    const names = Object.keys(
      (props['slots'] as Record<string, unknown>)['properties'] as Record<string, unknown>,
    );
    expect(names.some((n) => /id$/i.test(n))).toBe(false);
  });

  it('caps the same string lengths Zod caps', () => {
    const slots = (props['slots'] as Record<string, unknown>)['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(slots['text']?.['maxLength']).toBe(200);
    expect(slots['title']?.['maxLength']).toBe(200);
  });
});
