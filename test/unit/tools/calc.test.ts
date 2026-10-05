/**
 * `calc.compute` (2026-10-05): the grammar, the units, and what reaches the
 * model. Pure code, no network.
 */
import { describe, expect, it } from 'vitest';
import { convert, evaluate, formatNumber, renderTokens } from '../../../src/lookup/calc.js';
import { calcCompute } from '../../../src/tools/calc.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { scrubForModel } from '../../../src/security/scrub.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const value = (source: string) => {
  const result = evaluate(source);
  if (!result.ok) throw new Error(`${source}: ${result.error}`);
  return result.value;
};

describe('the calculator grammar', () => {
  it('follows the usual precedence', () => {
    expect(value('2+3*4')).toBe(14);
    expect(value('(2+3)*4')).toBe(20);
    expect(value('2^3^2')).toBe(512);
    expect(value('-2^2')).toBe(-4);
    expect(value('2*-3')).toBe(-6);
    expect(value('10/4')).toBe(2.5);
    expect(value('sqrt(16)+1')).toBe(5);
    expect(value('√(9)')).toBe(3);
    expect(value('6×7÷2')).toBe(21);
    expect(value('5−3')).toBe(2);
  });

  it('reads a percent as a hundredth, and after a plus or minus as a share of what came before', () => {
    expect(value('240*15%')).toBe(36);
    expect(value('15%')).toBe(0.15);
    expect(value('200+10%')).toBe(220);
    expect(value('200-10%')).toBe(180);
    expect(value('200+10%*2')).toBeCloseTo(200.2);
  });

  it('takes commas only as thousands separators', () => {
    expect(value('1,000*3')).toBe(3000);
    expect(value('1,234,567.5')).toBe(1234567.5);
    expect(evaluate('1,5')).toEqual({ ok: false, error: 'syntax' });
    expect(evaluate('1,5000')).toEqual({ ok: false, error: 'syntax' });
  });

  it('refuses anything outside the grammar', () => {
    for (const bad of ['', '2+', '(1+2', '1+2)', 'alert(1)', 'process.exit()', '2**3', '1;2', 'x+1', '$1', '2 3']) {
      expect(evaluate(bad).ok, bad).toBe(false);
    }
  });

  it('refuses division by zero and overflow', () => {
    expect(evaluate('1/0')).toEqual({ ok: false, error: 'not_finite' });
    expect(evaluate('10^400')).toEqual({ ok: false, error: 'not_finite' });
    expect(evaluate('sqrt(-1)')).toEqual({ ok: false, error: 'not_finite' });
  });

  it('caps length, tokens and depth', () => {
    expect(evaluate('1'.repeat(121))).toEqual({ ok: false, error: 'too_long' });
    expect(evaluate(Array.from({ length: 31 }, () => '1').join('+'))).toEqual({ ok: false, error: 'too_long' });
    expect(evaluate(`${'('.repeat(20)}1${')'.repeat(20)}`)).toEqual({ ok: false, error: 'syntax' });
    expect(value(`${'('.repeat(5)}1${')'.repeat(5)}`)).toBe(1);
  });
});

describe('units', () => {
  it('converts within a kind', () => {
    expect(convert(5, 'km', 'mi')).toBeCloseTo(3.1069, 4);
    expect(convert(100, 'c', 'f')).toBeCloseTo(212);
    expect(convert(32, 'f', 'c')).toBeCloseTo(0);
    expect(convert(1, 'dunam', 'sqm')).toBe(1000);
    expect(convert(60, 'mph', 'kmh')).toBeCloseTo(96.56, 2);
  });

  it('refuses across kinds', () => {
    expect(convert(1, 'kg', 'km')).toBeNull();
    expect(convert(1, 'c', 'm')).toBeNull();
  });
});

describe('rendering', () => {
  it('groups thousands and keeps at most four decimals', () => {
    expect(formatNumber(1234567.891234)).toBe('1,234,567.8912');
    expect(formatNumber(0.00001234)).toBe('1.234e-5');
    expect(formatNumber(0.00001)).toBe('1e-5');
    expect(formatNumber(-36)).toBe('-36');
  });

  it('rebuilds the expression so the model-bound scrub keeps it whole', () => {
    for (const source of ['100 - 20 - 30 - 40', '12500*12', '1234567+1', '0.00001*3']) {
      const result = evaluate(source);
      if (!result.ok) throw new Error(source);
      const text = `${renderTokens(result.tokens)} = ${formatNumber(result.value)}`;
      expect(scrubForModel(text), source).toBe(text);
    }
  });
});

describe('calc.compute', () => {
  const ctx = { lang: 'he', log: createFakeLogger() } as unknown as ToolContext;

  const run = async (slots: Record<string, unknown>, lang: 'he' | 'en' = 'he') => {
    const resolved = calcCompute.resolve(slots, { ...ctx, lang });
    if (resolved.kind !== 'ready') throw new Error('expected ready');
    const out = await calcCompute.execute(resolved.input, { ...ctx, lang });
    expect(out.tainting).toBeUndefined();
    return stripIsolates(out.text);
  };

  it('answers with the expression as read', async () => {
    expect(await run({ expression: '240*15%' })).toBe('240×15% = 36');
  });

  it('converts', async () => {
    expect(await run({ expression: '5', from_unit: 'km', to_unit: 'mi' })).toBe('5 ק״מ = 3.1069 מייל');
    expect(await run({ expression: '30', from_unit: 'c', to_unit: 'f' }, 'en')).toBe('30 °C = 86 °F');
    expect(await run({ expression: '3', from_unit: 'kg', to_unit: 'km' })).toBe('אי אפשר להמיר ק״ג לק״מ.');
  });

  it('says so when it cannot compute', async () => {
    expect(await run({ expression: '1/0' })).toContain('לא הצלחתי לחשב');
  });

  it('asks rather than guesses: no expression, or one end of a conversion', () => {
    expect(calcCompute.resolve({}, ctx)).toMatchObject({ kind: 'clarify' });
    expect(calcCompute.resolve({ expression: '5', from_unit: 'km' }, ctx)).toMatchObject({ kind: 'clarify' });
  });

  it('rejects slots outside the schema', () => {
    expect(calcCompute.resolve({ expression: '1', from_unit: 'parsec', to_unit: 'm' }, ctx)).toMatchObject({ kind: 'clarify' });
    expect(calcCompute.resolve({ expression: '1', extra: true }, ctx)).toMatchObject({ kind: 'clarify' });
  });
});
