/**
 * Arithmetic and unit conversion for `calc.compute` (2026-10-05).
 *
 * The model writes the expression; code reads it. A small tokenizer and a
 * recursive-descent parser over a closed grammar, so nothing the model writes
 * is ever run as code (CLAUDE.md, "Secrets and privacy"):
 *
 *   expr    = term (("+" | "-") term)*
 *   term    = unary (("*" | "/") unary)*
 *   unary   = "-" unary | "+" unary | power
 *   power   = postfix ("^" unary)?
 *   postfix = primary "%"?
 *   primary = number | "(" expr ")" | "sqrt" "(" expr ")"
 *
 * `-2^2` is -4, as on paper. A percent is a hundredth, except right after a
 * plus or a minus, where it is a share of what came before: `200+10%` is 220,
 * as on a phone's calculator.
 */

export const MAX_EXPRESSION_CHARS = 120;
const MAX_TOKENS = 60;
const MAX_DEPTH = 12;

/** What an expression may contain at all; checked before tokenizing. */
const ALLOWED = /^[0-9.,+\-*/×÷^%()\s√a-z−]*$/i;

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' | '%' | '(' | ')' }
  | { kind: 'sqrt' };

export type CalcError = 'syntax' | 'too_long' | 'not_finite' | 'unit_mismatch';
export type CalcResult = { ok: true; value: number; tokens: Token[] } | { ok: false; error: CalcError };

/** Thousands are grouped by commas only in threes: `1,000` is a thousand, `1,5` is refused. */
const NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|^\.\d+/;

function tokenize(source: string): Token[] | CalcError {
  if (source.length > MAX_EXPRESSION_CHARS) return 'too_long';
  if (!ALLOWED.test(source)) return 'syntax';
  const text = source.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/√/g, 'sqrt');
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const number = NUMBER.exec(text.slice(i));
    if (number && /[\d.]/.test(ch)) {
      const value = Number(number[0].replace(/,/g, ''));
      if (!Number.isFinite(value)) return 'syntax';
      tokens.push({ kind: 'num', value });
      i += number[0].length;
    } else if (text.slice(i, i + 4).toLowerCase() === 'sqrt') {
      tokens.push({ kind: 'sqrt' });
      i += 4;
    } else if ('+-*/^%()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch as '+' });
      i++;
    } else {
      return 'syntax';
    }
    if (tokens.length > MAX_TOKENS) return 'too_long';
  }
  return tokens;
}

class Parser {
  private at = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expr();
    if (this.at !== this.tokens.length) throw new SyntaxError();
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'op' && token.value === value;
  }

  private nest<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new SyntaxError();
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private expr(): number {
    return this.nest(() => {
      let left = this.term();
      while (this.isOp('+') || this.isOp('-')) {
        const plus = this.isOp('+');
        this.at++;
        const { value, percent } = this.termWithPercent();
        const right = percent ? (left * value) / 100 : value;
        left = plus ? left + right : left - right;
      }
      return left;
    });
  }

  /** A term right after a plus or a minus, noting whether it was a bare percent. */
  private termWithPercent(): { value: number; percent: boolean } {
    const start = this.at;
    const primary = this.tokens[start];
    const percentNext = this.tokens[start + 1];
    // `200+10%` (and only a bare number with a percent, ending the term).
    if (
      primary?.kind === 'num' &&
      percentNext?.kind === 'op' &&
      percentNext.value === '%' &&
      !this.continuesTerm(start + 2)
    ) {
      this.at = start + 2;
      return { value: primary.value, percent: true };
    }
    return { value: this.term(), percent: false };
  }

  private continuesTerm(index: number): boolean {
    const token = this.tokens[index];
    return token?.kind === 'op' && (token.value === '*' || token.value === '/' || token.value === '^');
  }

  private term(): number {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const times = this.isOp('*');
      this.at++;
      const right = this.unary();
      left = times ? left * right : left / right;
    }
    return left;
  }

  private unary(): number {
    return this.nest(() => {
      if (this.isOp('-')) {
        this.at++;
        return -this.unary();
      }
      if (this.isOp('+')) {
        this.at++;
        return this.unary();
      }
      return this.power();
    });
  }

  private power(): number {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.at++;
      return base ** this.unary();
    }
    return base;
  }

  private postfix(): number {
    let value = this.primary();
    if (this.isOp('%')) {
      this.at++;
      value /= 100;
    }
    return value;
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new SyntaxError();
    if (token.kind === 'num') {
      this.at++;
      return token.value;
    }
    if (token.kind === 'sqrt') {
      this.at++;
      if (!this.isOp('(')) throw new SyntaxError();
      return Math.sqrt(this.group());
    }
    if (this.isOp('(')) return this.group();
    throw new SyntaxError();
  }

  private group(): number {
    this.at++;
    const value = this.expr();
    if (!this.isOp(')')) throw new SyntaxError();
    this.at++;
    return value;
  }
}

/** Read and compute an expression, or say why not. */
export function evaluate(source: string): CalcResult {
  const tokens = tokenize(source);
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  if (tokens.length === 0) return { ok: false, error: 'syntax' };
  let value: number;
  try {
    value = new Parser(tokens).parse();
  } catch {
    return { ok: false, error: 'syntax' };
  }
  if (!Number.isFinite(value)) return { ok: false, error: 'not_finite' };
  return { ok: true, value, tokens };
}

// -- Units --------------------------------------------------------------------

export const UNITS = [
  'm', 'km', 'cm', 'mm', 'mi', 'ft', 'in', 'yd',
  'kg', 'g', 'lb', 'oz',
  'l', 'ml', 'gal',
  'kmh', 'mph',
  'c', 'f', 'k',
  'sqm', 'sqft', 'dunam', 'acre',
] as const;

export type Unit = (typeof UNITS)[number];
type Dimension = 'length' | 'mass' | 'volume' | 'speed' | 'temperature' | 'area';

/** Each unit's dimension and size in that dimension's base unit. */
const SIZES: Record<Exclude<Unit, 'c' | 'f' | 'k'>, { dim: Dimension; base: number }> = {
  m: { dim: 'length', base: 1 },
  km: { dim: 'length', base: 1000 },
  cm: { dim: 'length', base: 0.01 },
  mm: { dim: 'length', base: 0.001 },
  mi: { dim: 'length', base: 1609.344 },
  ft: { dim: 'length', base: 0.3048 },
  in: { dim: 'length', base: 0.0254 },
  yd: { dim: 'length', base: 0.9144 },
  kg: { dim: 'mass', base: 1 },
  g: { dim: 'mass', base: 0.001 },
  lb: { dim: 'mass', base: 0.45359237 },
  oz: { dim: 'mass', base: 0.028349523125 },
  l: { dim: 'volume', base: 1 },
  ml: { dim: 'volume', base: 0.001 },
  gal: { dim: 'volume', base: 3.785411784 },
  kmh: { dim: 'speed', base: 1 },
  mph: { dim: 'speed', base: 1.609344 },
  sqm: { dim: 'area', base: 1 },
  sqft: { dim: 'area', base: 0.09290304 },
  dunam: { dim: 'area', base: 1000 },
  acre: { dim: 'area', base: 4046.8564224 },
};

const TEMPERATURES = new Set<Unit>(['c', 'f', 'k']);

function toKelvin(value: number, unit: Unit): number {
  if (unit === 'c') return value + 273.15;
  if (unit === 'f') return ((value - 32) * 5) / 9 + 273.15;
  return value;
}

function fromKelvin(value: number, unit: Unit): number {
  if (unit === 'c') return value - 273.15;
  if (unit === 'f') return ((value - 273.15) * 9) / 5 + 32;
  return value;
}

/** A value in one unit, in another of the same kind, or null when they do not convert. */
export function convert(value: number, from: Unit, to: Unit): number | null {
  if (TEMPERATURES.has(from) || TEMPERATURES.has(to)) {
    if (!TEMPERATURES.has(from) || !TEMPERATURES.has(to)) return null;
    return fromKelvin(toKelvin(value, from), to);
  }
  const a = SIZES[from as keyof typeof SIZES];
  const b = SIZES[to as keyof typeof SIZES];
  if (a.dim !== b.dim) return null;
  return (value * a.base) / b.base;
}

// -- Rendering ----------------------------------------------------------------

/**
 * A number as people write it: grouped by commas, at most four decimals, and
 * very small values in exponent form rather than as a misleading zero. Commas
 * and the short fractions also keep the model-bound scrub, which replaces long
 * digit runs, from eating the answer (src/security/scrub.ts).
 */
export function formatNumber(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(3).replace(/\.?0+e/, 'e');
  if (Math.abs(value) >= 1e15) return value.toExponential(3).replace(/\.?0+e/, 'e');
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
}

/**
 * The expression as read, rebuilt from its tokens: numbers grouped, no spaces,
 * and the minus as U+2212 so a chain like `100-20-30` never looks like a phone
 * number to the scrub.
 */
export function renderTokens(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.kind === 'num') return formatNumber(token.value);
      if (token.kind === 'sqrt') return '√';
      if (token.value === '-') return '−';
      if (token.value === '*') return '×';
      if (token.value === '/') return '÷';
      return token.value;
    })
    .join('');
}
