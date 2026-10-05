/**
 * `calc.compute` (2026-10-05, ROADMAP #12): arithmetic and unit conversion.
 * Tier 0, agent-only.
 *
 * The model writes the expression the user asked about; code reads it with its
 * own grammar and computes it (`src/lookup/calc.ts`). The reply echoes the
 * expression as code read it, so a misreading shows. Numbers and code-made
 * words only: this read does not taint the turn.
 */
import { z } from 'zod';
import { calcComputeSlots } from '../nlu/slot-schemas.js';
import { convert, evaluate, formatNumber, MAX_EXPRESSION_CHARS, renderTokens, UNITS } from '../lookup/calc.js';
import type { Unit } from '../lookup/calc.js';
import { isolateLtr } from '../render/bidi.js';
import type { Lang } from '../render/format-time.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';

const inputSchema = z
  .object({
    expression: z.string().min(1).max(MAX_EXPRESSION_CHARS),
    from: z.enum(UNITS).optional(),
    to: z.enum(UNITS).optional(),
  })
  .strict();

type CalcInput = z.infer<typeof inputSchema>;

const UNIT_NAMES: Record<Unit, { he: string; en: string }> = {
  m: { he: 'מטר', en: 'm' },
  km: { he: 'ק״מ', en: 'km' },
  cm: { he: 'ס״מ', en: 'cm' },
  mm: { he: 'מ״מ', en: 'mm' },
  mi: { he: 'מייל', en: 'mi' },
  ft: { he: 'רגל', en: 'ft' },
  in: { he: 'אינץ׳', en: 'in' },
  yd: { he: 'יארד', en: 'yd' },
  kg: { he: 'ק״ג', en: 'kg' },
  g: { he: 'גרם', en: 'g' },
  lb: { he: 'ליברה', en: 'lb' },
  oz: { he: 'אונקיה', en: 'oz' },
  l: { he: 'ליטר', en: 'L' },
  ml: { he: 'מ״ל', en: 'mL' },
  gal: { he: 'גלון', en: 'gal' },
  kmh: { he: 'קמ״ש', en: 'km/h' },
  mph: { he: 'מייל לשעה', en: 'mph' },
  c: { he: '°C', en: '°C' },
  f: { he: '°F', en: '°F' },
  k: { he: 'קלווין', en: 'K' },
  sqm: { he: 'מ״ר', en: 'm²' },
  sqft: { he: 'רגל רבועה', en: 'sq ft' },
  dunam: { he: 'דונם', en: 'dunam' },
  acre: { he: 'אקר', en: 'acres' },
};

const unitName = (unit: Unit, lang: Lang) => UNIT_NAMES[unit][lang];

function cannot(lang: Lang): string {
  return lang === 'he'
    ? 'לא הצלחתי לחשב את זה. אפשר לנסח את החישוב אחרת.'
    : 'I could not compute that. Try phrasing the calculation differently.';
}

export const calcCompute: ToolDefinition = {
  name: 'calc.compute',
  inputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = calcComputeSlots.safeParse(rawSlots);
    if (!slots.success || !slots.data.expression) {
      return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    }
    const { expression, from_unit: from, to_unit: to } = slots.data;
    // A conversion names both ends; one alone is a question, not a guess.
    if ((from === undefined) !== (to === undefined)) {
      return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    }
    return {
      kind: 'ready',
      input: { expression, ...(from && to ? { from, to } : {}) } satisfies CalcInput,
    };
  },

  preview(_rawInput, lang): string {
    return lang === 'he' ? 'חישוב' : 'Calculation';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CalcInput>(inputSchema, rawInput, 'calc.compute');
    const result = evaluate(input.expression);
    if (!result.ok) {
      ctx.log.info('calc_failed', { errorCode: result.error });
      return { text: cannot(ctx.lang) };
    }
    const read = renderTokens(result.tokens);
    const he = ctx.lang === 'he';

    if (!input.from || !input.to) {
      return { text: isolateLtr(`${read} = ${formatNumber(result.value)}`) };
    }

    const converted = convert(result.value, input.from, input.to);
    if (converted === null || !Number.isFinite(converted)) {
      ctx.log.info('calc_failed', { errorCode: 'unit_mismatch' });
      return {
        text: he
          ? `אי אפשר להמיר ${unitName(input.from, 'he')} ל${unitName(input.to, 'he')}.`
          : `${unitName(input.from, 'en')} does not convert to ${unitName(input.to, 'en')}.`,
      };
    }
    const left = `${isolateLtr(read)} ${unitName(input.from, ctx.lang)}`;
    const right = `${isolateLtr(formatNumber(converted))} ${unitName(input.to, ctx.lang)}`;
    return { text: `${left} = ${right}` };
  },
};
