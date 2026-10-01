/**
 * The Groq free-tier budget, per model (PLAN §2, §6.19).
 *
 * 8K tokens per minute and 200K per day, each model separately, and the cache
 * cannot be counted on. A turn that would not fit a model's minute bucket is not
 * started on it: a 429 halfway through a turn costs the tokens already spent and
 * leaves the turn unfinished.
 *
 * Memory only. A Durable Object that is evicted forgets the last minute, which
 * at worst costs one 429 — and a 429 is handled. The daily limit is learned the
 * only way Groq reveals it: a `retry-after` of minutes rather than seconds.
 */

import type { NluProvider } from '../nlu/provider.js';

/** Below Groq's 8,000, so an estimate that runs a little short still fits. */
export const MINUTE_TOKEN_LIMIT = 7_500;
const WINDOW_MS = 60_000;

/** A `retry-after` longer than this is the daily budget, not the minute one. */
const DAILY_SIGNAL_SECONDS = 60;

type Spend = { at: number; tokens: number };

export class TokenBudget {
  private readonly spends = new Map<string, Spend[]>();
  private readonly exhaustedUntil = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /** Tokens this model has used in the last minute. */
  usedInWindow(model: string): number {
    const cutoff = this.now() - WINDOW_MS;
    const live = (this.spends.get(model) ?? []).filter((spend) => spend.at > cutoff);
    this.spends.set(model, live);
    return live.reduce((sum, spend) => sum + spend.tokens, 0);
  }

  isExhausted(model: string): boolean {
    const until = this.exhaustedUntil.get(model);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.exhaustedUntil.delete(model);
      return false;
    }
    return true;
  }

  /** Would a call estimated at `tokens` fit this model's minute bucket now? */
  fits(model: string, tokens: number): boolean {
    return !this.isExhausted(model) && this.usedInWindow(model) + tokens <= MINUTE_TOKEN_LIMIT;
  }

  /** The first model, in order, that can take a turn of this size. */
  pick(models: readonly string[], tokens: number): string | null {
    return models.find((model) => this.fits(model, tokens)) ?? null;
  }

  record(model: string, tokens: number): void {
    if (tokens <= 0) return;
    const list = this.spends.get(model) ?? [];
    list.push({ at: this.now(), tokens });
    this.spends.set(model, list);
  }

  /**
   * A 429. A short `retry-after` is the minute bucket, which the window already
   * models; a long one is the day, and the model is set aside until then.
   */
  rateLimited(model: string, retryAfterSeconds: number | undefined): void {
    const seconds = retryAfterSeconds ?? 0;
    if (seconds > DAILY_SIGNAL_SECONDS) {
      this.exhaustedUntil.set(model, this.now() + seconds * 1000);
      return;
    }
    // Fill the window so the next turn waits out the minute instead of retrying into it.
    this.record(model, MINUTE_TOKEN_LIMIT);
  }
}

/**
 * The parser fallback runs on the same models, so it spends from the same
 * budget: its measured usage is recorded, and a model already known to be out
 * for the day is skipped rather than asked again (plan K3).
 */
export function meterParsers(providers: readonly NluProvider[], budget: TokenBudget): NluProvider[] {
  return providers.map((provider) => {
    const model = provider.name.startsWith('groq:') ? provider.name.slice('groq:'.length) : null;
    if (model === null) return provider;

    return {
      name: provider.name,
      async parse(input) {
        if (budget.isExhausted(model)) {
          return { ok: false, error: { code: 'rate_limited', status: 429 } };
        }
        const response = await provider.parse(input);
        if (response.ok) {
          budget.record(model, response.usage.promptTokens + response.usage.completionTokens);
        } else if (response.error.code === 'rate_limited') {
          budget.rateLimited(model, response.error.retryAfterSeconds);
        }
        return response;
      },
    };
  });
}
