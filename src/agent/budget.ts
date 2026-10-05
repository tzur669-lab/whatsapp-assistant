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
 *
 * Groq's own reading of the minute bucket, from the headers of its last answer,
 * is trusted over this server's count while it is fresh (2026-10-05). This
 * server's estimate ran ahead of Groq's: a second message 14 s after a turn was
 * refused here while Groq still had room. Measured: the header already takes off
 * the call that carried it, prompt plus its reserved `max_tokens`.
 */

import type { NluProvider } from '../nlu/provider.js';
import type { Bucket } from '../core/quota.js';

/** Below Groq's 8,000, so an estimate that runs a little short still fits. */
export const MINUTE_TOKEN_LIMIT = 7_500;
const WINDOW_MS = 60_000;

/** A `retry-after` longer than this is the daily budget, not the minute one. */
const DAILY_SIGNAL_SECONDS = 60;

/** Kept under Groq's own minute limit when that is the lower one. */
const LEARNED_LIMIT_MARGIN = 500;

type Spend = { at: number; tokens: number };

/** Groq's minute bucket as its last answer reported it. */
type Observation = Bucket & { observedAt: number };

/** A reading this old is past any reset Groq can report; the bucket is full again. */
const OBSERVATION_TTL_MS = WINDOW_MS;

/** One model's state as this server sees it, for the quota screen. */
export type BudgetSnapshot = {
  model: string;
  /** Tokens spent in the last minute, as this server counts them. */
  used: number;
  limit: number;
  /** When the oldest spend in the window leaves it; null when nothing is in it. */
  freesAt: number | null;
  /** Set aside after a 429 that named the day: until when. */
  blockedUntil: number | null;
};

export class TokenBudget {
  private readonly spends = new Map<string, Spend[]>();
  private readonly exhaustedUntil = new Map<string, number>();
  private readonly learnedLimits = new Map<string, number>();
  private readonly observations = new Map<string, Observation>();

  constructor(
    private readonly now: () => number,
    /** Told of every real spend, for the quota screen's daily count. Never of a 429's fill. */
    private readonly onSpend?: (model: string, tokens: number) => void,
  ) {}

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

  /**
   * Groq's minute limit for a model, from its own headers (2026-10-01). Models
   * differ, and one below the assumed 8K made every busy minute a 429.
   */
  learnMinuteLimit(model: string, limit: number): void {
    if (Number.isInteger(limit) && limit > 0) this.learnedLimits.set(model, limit);
  }

  /** The minute bucket this server spends against: the assumption, or Groq's own when lower. */
  limitFor(model: string): number {
    const learned = this.learnedLimits.get(model);
    if (learned === undefined) return MINUTE_TOKEN_LIMIT;
    return Math.max(0, Math.min(MINUTE_TOKEN_LIMIT, learned - LEARNED_LIMIT_MARGIN));
  }

  /** Groq's own reading of a model's minute bucket, from its response headers. */
  observe(model: string, bucket: Bucket): void {
    if (!Number.isInteger(bucket.limit) || bucket.limit <= 0) return;
    this.observations.set(model, { ...bucket, observedAt: this.now() });
  }

  /**
   * Groq's bucket now: the reading, refilled in a straight line to the limit by
   * its reset time. Null when there is no fresh reading.
   */
  private observedRoom(model: string): { limit: number; room: number; resetAt: number } | null {
    const seen = this.observations.get(model);
    if (!seen) return null;
    const now = this.now();
    if (now - seen.observedAt >= OBSERVATION_TTL_MS) {
      this.observations.delete(model);
      return null;
    }
    const limit = Math.min(seen.limit, MINUTE_TOKEN_LIMIT + LEARNED_LIMIT_MARGIN);
    const remaining = Math.min(seen.remaining, limit);
    const span = seen.resetAt - seen.observedAt;
    const refilled =
      now >= seen.resetAt || span <= 0
        ? limit
        : remaining + ((limit - remaining) * (now - seen.observedAt)) / span;
    return { limit, room: Math.floor(Math.min(limit, refilled)), resetAt: seen.resetAt };
  }

  /** Tokens a call may take now: Groq's own bucket while fresh, else this server's window. */
  available(model: string): number {
    const observed = this.observedRoom(model);
    if (observed) return Math.max(0, observed.room - LEARNED_LIMIT_MARGIN);
    return Math.max(0, this.limitFor(model) - this.usedInWindow(model));
  }

  /** Would a call estimated at `tokens` fit this model's minute bucket now? */
  fits(model: string, tokens: number): boolean {
    return !this.isExhausted(model) && tokens <= this.available(model);
  }

  snapshot(models: readonly string[]): BudgetSnapshot[] {
    return models.map((model) => {
      const observed = this.observedRoom(model);
      if (observed) {
        return {
          model,
          used: observed.limit - observed.room,
          limit: observed.limit,
          freesAt: observed.room < observed.limit ? observed.resetAt : null,
          blockedUntil: this.isExhausted(model) ? (this.exhaustedUntil.get(model) ?? null) : null,
        };
      }
      const used = this.usedInWindow(model);
      const oldest = this.spends.get(model)?.[0];
      return {
        model,
        used,
        limit: this.limitFor(model),
        freesAt: oldest ? oldest.at + WINDOW_MS : null,
        blockedUntil: this.isExhausted(model) ? (this.exhaustedUntil.get(model) ?? null) : null,
      };
    });
  }

  /** The first model, in order, that can take a turn of this size. */
  pick(models: readonly string[], tokens: number): string | null {
    return models.find((model) => this.fits(model, tokens)) ?? null;
  }

  record(model: string, tokens: number): void {
    if (tokens <= 0) return;
    this.fill(model, tokens);
    this.onSpend?.(model, tokens);
  }

  private fill(model: string, tokens: number): void {
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
    // Fill the window so the next turn waits out the minute instead of retrying
    // into it. Not a spend: nothing was billed.
    this.fill(model, this.limitFor(model));
    // The 429's own headers were read first; Groq's bucket is empty until its
    // reset, whatever they said.
    const seen = this.observations.get(model);
    if (seen) {
      this.observations.set(model, { ...seen, remaining: 0, observedAt: this.now() });
    } else {
      const resetAt = this.now() + Math.max(seconds, 1) * 1000;
      this.observations.set(model, { limit: MINUTE_TOKEN_LIMIT + LEARNED_LIMIT_MARGIN, remaining: 0, resetAt, observedAt: this.now() });
    }
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
