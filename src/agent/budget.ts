/**
 * The Groq free-tier budget, per model (PLAN §2, §6.19).
 *
 * Each model has its own minute bucket (`models.ts`), and the cache cannot be
 * counted on. A call that would not fit a model's minute bucket is not started
 * on it: a 429 halfway through a turn costs the tokens already spent and leaves
 * the turn unfinished.
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
 *
 * Reservations (2026-10-06). Every call takes its estimate out of the bucket
 * before it is sent, in the same synchronous step as the check, so two messages
 * in flight on one model cannot both be admitted against the same room. The
 * local view may count a call twice — an open reservation and a header that
 * already includes it — which only ever costs an extra failover. It never
 * counts a measured call as less than it was.
 *
 * Request limits (2026-10-08). A model whose entry declares `minuteRequests`
 * or `dayRequests` (Gemini) is also counted in requests: per minute in the
 * same sliding window, per Pacific day through an injected synchronous
 * `DayRequestCounter` (SQLite in the Durable Object), taken in `reserve` and
 * given back in `release`. Every 429 on such a model backs off 1, 2, 5, then
 * 10 minutes, reset by a success, or until Pacific midnight when the 429 named
 * the day; a longer `retry-after` wins. Groq models declare neither, so none
 * of this runs for them: their behaviour is exactly as before.
 */

import type { NluProvider } from '../nlu/provider.js';
import type { PromptInput } from '../nlu/prompt.js';
import { buildPrompt } from '../nlu/prompt.js';
import { buildResponseSchema } from '../nlu/json-schema.js';
import type { Bucket } from '../core/quota.js';
import { DEFAULT_MINUTE_TOKENS, GROQ_CHARS_PER_TOKEN, modelEntry } from './models.js';
import { addDays, localPartsOf, wallTimeToUtc } from '../time/tz.js';

/** Below Groq's 8,000, so an estimate that runs a little short still fits. */
export const MINUTE_TOKEN_LIMIT = DEFAULT_MINUTE_TOKENS - 500;
const WINDOW_MS = 60_000;

/** A `retry-after` longer than this is the daily budget, not the minute one. */
const DAILY_SIGNAL_SECONDS = 60;

/** Kept under Groq's own minute limit when that is the lower one. */
const LEARNED_LIMIT_MARGIN = 500;

/** A model the provider says it does not have (404) is not asked again for this long. */
const UNAVAILABLE_MS = 60 * 60 * 1000;

/** The parser's own `max_completion_tokens` (`src/nlu/groq.ts`), reserved in full. */
export const PARSER_MAX_COMPLETION_TOKENS = 2_048;

/**
 * Characters per token, for every estimate and reservation. Measured
 * (2026-10-07, `test/fixtures/token-calibration.json`, 24 real calls): qwen
 * ran 3.15–3.66, gpt-oss about 4.95. 3.0 stays under every measured call,
 * which the calibration test holds at 99%. At the spike's 2.5 the full
 * catalog alone estimated past the 7,000 turn cap, so a message that named no
 * tool group failed `turn_token_cap` before any model was asked.
 */
export const CHARS_PER_TOKEN = GROQ_CHARS_PER_TOKEN;

type Spend = { at: number; tokens: number };

/** Groq's minute bucket as its last answer reported it. */
type Observation = Bucket & { observedAt: number };

/** A reading this old is past any reset Groq can report; the bucket is full again. */
const OBSERVATION_TTL_MS = WINDOW_MS;

/**
 * What a 429 told us, as the provider's adapter reads it. `overloaded`
 * (2026-10-08): a smart model's 503 or 500 — busy, not out of quota.
 */
export type RateLimitKind = 'minute' | 'day' | 'unavailable' | 'overloaded';

/**
 * One call's claim on a model's minute, from before it is sent until it
 * settles. `day` is set only for a model with a daily request limit: the
 * Pacific day the request was counted on, so `release` gives it back there.
 */
export type Reservation = { readonly id: number; readonly model: string; readonly tokens: number; readonly day?: string };

/** Google resets per-day quotas at midnight Pacific time. */
export const QUOTA_ZONE = 'America/Los_Angeles';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Pacific calendar day of an instant, `YYYY-MM-DD`: the key of the day counter. */
export function quotaDay(utcMs: number): string {
  const p = localPartsOf(utcMs, QUOTA_ZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The next Pacific midnight after an instant. Never early: a fold takes its later instant. */
export function nextQuotaMidnight(utcMs: number): number {
  const p = localPartsOf(utcMs, QUOTA_ZONE);
  const next = addDays({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, 1);
  const resolved = wallTimeToUtc(next, QUOTA_ZONE);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return resolved.utcMsCandidates[1];
  // Los Angeles never skips midnight; were it to, a full day is the safe side.
  return utcMs + DAY_MS;
}

/**
 * Requests per model per Pacific day, read and written synchronously inside
 * `fits`/`reserve`, so nothing awaits between the check and the claim. It
 * outlives the Durable Object's memory (SQLite, `core/quota.ts`); it is an
 * estimate all the same, and the provider's 429 has the last word.
 */
export interface DayRequestCounter {
  get(day: string, model: string): number;
  bump(day: string, model: string, delta: 1 | -1): void;
}

/** The counter in memory: tests, and anything that has no SQLite. */
export class MemoryDayRequestCounter implements DayRequestCounter {
  private readonly counts = new Map<string, number>();

  get(day: string, model: string): number {
    return this.counts.get(`${day}\0${model}`) ?? 0;
  }

  bump(day: string, model: string, delta: 1 | -1): void {
    const key = `${day}\0${model}`;
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) + delta));
  }
}

/** The backoff after each successive 429 on a request-limited model, in minutes. */
export const RATE_BACKOFF_MINUTES = [1, 2, 5, 10] as const;

/**
 * One message's memory of which models refused it (§2b). A model in it is not
 * asked again for this message — not by the agent, the parser, or the
 * read-only try. Memory only, one per message, never kept.
 */
export type MessageScope = { readonly refused: Set<string> };

export function newMessageScope(): MessageScope {
  return { refused: new Set<string>() };
}

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
  private readonly open = new Map<number, Reservation>();
  /** After a short 429: no room at all until the provider's `retry-after` has passed. */
  private readonly minuteBlockedUntil = new Map<string, number>();
  /** Request-limited models only: how many 429s in a row since the last success. */
  private readonly backoffStep = new Map<string, number>();
  private nextReservation = 0;

  constructor(
    private readonly now: () => number,
    /** Told of every real spend, for the quota screen's daily count. Never of a 429's fill. */
    private readonly onSpend?: (model: string, tokens: number) => void,
    /** Requests per Pacific day, for models that declare `dayRequests`. Never touched for the others. */
    private readonly dayCounter: DayRequestCounter = new MemoryDayRequestCounter(),
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

  /** The model's configured bucket (`models.ts`), or the assumed 8K for one it does not list. */
  private configuredLimit(model: string): number {
    return modelEntry(model)?.minuteTokens ?? DEFAULT_MINUTE_TOKENS;
  }

  /** The minute bucket this server spends against: the configured one, or Groq's own when lower. */
  limitFor(model: string): number {
    const configured = this.configuredLimit(model) - LEARNED_LIMIT_MARGIN;
    const learned = this.learnedLimits.get(model);
    if (learned === undefined) return Math.max(0, configured);
    return Math.max(0, Math.min(configured, learned - LEARNED_LIMIT_MARGIN));
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
    const limit = Math.min(seen.limit, this.configuredLimit(model));
    const remaining = Math.min(seen.remaining, limit);
    const span = seen.resetAt - seen.observedAt;
    const refilled =
      now >= seen.resetAt || span <= 0
        ? limit
        : remaining + ((limit - remaining) * (now - seen.observedAt)) / span;
    return { limit, room: Math.floor(Math.min(limit, refilled)), resetAt: seen.resetAt };
  }

  /** Tokens held by calls in flight on this model. */
  reservedFor(model: string): number {
    let sum = 0;
    for (const reservation of this.open.values()) {
      if (reservation.model === model) sum += reservation.tokens;
    }
    return sum;
  }

  /**
   * Tokens a call may take now: Groq's own bucket while fresh, else this
   * server's window — less every call still in flight on the model.
   */
  available(model: string): number {
    const blockedUntil = this.minuteBlockedUntil.get(model);
    if (blockedUntil !== undefined) {
      if (this.now() < blockedUntil) return 0;
      this.minuteBlockedUntil.delete(model);
    }
    const observed = this.observedRoom(model);
    const room = observed
      ? observed.room - LEARNED_LIMIT_MARGIN
      : this.limitFor(model) - this.usedInWindow(model);
    return Math.max(0, room - this.reservedFor(model));
  }

  /**
   * Calls this model has sent in the last minute, plus those in flight. Every
   * sent call leaves one entry in the window (`settle`, `chargeUnanswered`).
   */
  requestsInWindow(model: string): number {
    const cutoff = this.now() - WINDOW_MS;
    const live = (this.spends.get(model) ?? []).filter((spend) => spend.at > cutoff);
    this.spends.set(model, live);
    let inFlight = 0;
    for (const reservation of this.open.values()) {
      if (reservation.model === model) inFlight++;
    }
    return live.length + inFlight;
  }

  /** Room for one more request, for a model that declares request limits; always true for the others. */
  private requestsFit(model: string): boolean {
    const entry = modelEntry(model);
    if (entry?.minuteRequests !== undefined && this.requestsInWindow(model) >= entry.minuteRequests) return false;
    if (entry?.dayRequests !== undefined && this.dayCounter.get(quotaDay(this.now()), model) >= entry.dayRequests) {
      return false;
    }
    return true;
  }

  /** Would a call estimated at `tokens` fit this model's minute bucket (and request limits) now? */
  fits(model: string, tokens: number): boolean {
    return !this.isExhausted(model) && tokens <= this.available(model) && this.requestsFit(model);
  }

  snapshot(models: readonly string[]): BudgetSnapshot[] {
    return models.map((model) => {
      const observed = this.observedRoom(model);
      const blockedUntil = this.isExhausted(model) ? (this.exhaustedUntil.get(model) ?? null) : null;
      if (observed) {
        return {
          model,
          used: Math.min(observed.limit, observed.limit - observed.room + this.reservedFor(model)),
          limit: observed.limit,
          freesAt: observed.room < observed.limit ? observed.resetAt : null,
          blockedUntil,
        };
      }
      const limit = this.limitFor(model);
      const used = this.usedInWindow(model);
      const oldest = this.spends.get(model)?.[0];
      return {
        model,
        used: Math.min(limit, used + this.reservedFor(model)),
        limit,
        freesAt: oldest ? oldest.at + WINDOW_MS : null,
        blockedUntil,
      };
    });
  }

  /** The first model, in order, that can take a turn of this size. */
  pick(models: readonly string[], tokens: number): string | null {
    return models.find((model) => this.fits(model, tokens)) ?? null;
  }

  /**
   * Check and claim in one step: a reservation for `tokens` on `model`, or null
   * when it does not fit. Nothing awaits between the check and the claim, so a
   * second message cannot be admitted against the same room.
   */
  reserve(model: string, tokens: number): Reservation | null {
    if (!this.fits(model, tokens)) return null;
    const day = modelEntry(model)?.dayRequests !== undefined ? quotaDay(this.now()) : undefined;
    const reservation: Reservation = {
      id: ++this.nextReservation,
      model,
      tokens: Math.max(0, Math.ceil(tokens)),
      ...(day === undefined ? {} : { day }),
    };
    this.open.set(reservation.id, reservation);
    if (day !== undefined) this.dayCounter.bump(day, model, 1);
    return reservation;
  }

  /** Is this reservation still held? For tests and assertions. */
  isOpen(reservation: Reservation): boolean {
    return this.open.has(reservation.id);
  }

  /**
   * The call answered: charge what it measured, or — when the answer carried no
   * usage — the whole reservation. Never zero for a call that was sent.
   */
  settle(reservation: Reservation, measuredTokens: number): void {
    if (!this.open.delete(reservation.id)) return;
    this.record(reservation.model, measuredTokens > 0 ? measuredTokens : reservation.tokens);
    // A success starts a request-limited model's 429 ladder over.
    this.backoffStep.delete(reservation.model);
  }

  /**
   * The call was sent and failed without a usable answer — timeout, dropped
   * connection, an error status, a body that would not parse. It may have been
   * billed, so the reservation is charged, and taken off Groq's reading too:
   * no header came back to include it.
   */
  chargeUnanswered(reservation: Reservation): void {
    if (!this.open.delete(reservation.id)) return;
    this.record(reservation.model, reservation.tokens);
    const seen = this.observations.get(reservation.model);
    if (seen) {
      this.observations.set(reservation.model, { ...seen, remaining: Math.max(0, seen.remaining - reservation.tokens) });
    }
  }

  /** The call was never sent (no key, connection refused). Nothing to charge, and its day request goes back. */
  release(reservation: Reservation): void {
    if (this.open.delete(reservation.id) && reservation.day !== undefined) {
      this.dayCounter.bump(reservation.day, reservation.model, -1);
    }
  }

  /**
   * A 429 on a reserved call: the reservation goes, and the model is blocked as
   * `rateLimited` blocks it — one synchronous step, so no reserve in between
   * sees the room the reservation held without the block.
   */
  refused(reservation: Reservation, retryAfterSeconds: number | undefined, kind?: RateLimitKind): void {
    this.open.delete(reservation.id);
    this.rateLimited(reservation.model, retryAfterSeconds, kind);
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
   * A 429, from whichever of Groq's limits was hit first — it is not
   * classified. A long `retry-after` sets the model aside until then (`day` is
   * the old name for that: until the time given, never midnight); a short one
   * fills the window and empties Groq's reading until the later of its own
   * reset and the `retry-after`. Over-blocking is accepted; unblocking early is
   * not.
   */
  rateLimited(model: string, retryAfterSeconds: number | undefined, kind?: RateLimitKind): void {
    const seconds = retryAfterSeconds ?? 0;
    const now = this.now();
    if (kind === 'unavailable') {
      this.exhaustedUntil.set(model, now + UNAVAILABLE_MS);
      return;
    }
    if (kind === 'overloaded') {
      // The 429 ladder, never the day: it was busy, not out of quota.
      this.backOff(model, seconds, false);
      return;
    }
    if (modelEntry(model)?.minuteRequests !== undefined) {
      this.backOff(model, seconds, kind === 'day');
      return;
    }
    if (kind === 'day' || seconds > DAILY_SIGNAL_SECONDS) {
      this.exhaustedUntil.set(model, now + seconds * 1000);
      return;
    }
    // Fill the window so the next turn waits out the minute instead of retrying
    // into it. Not a spend: nothing was billed.
    this.fill(model, this.limitFor(model));
    const retryAt = now + Math.max(seconds, 1) * 1000;
    this.minuteBlockedUntil.set(model, Math.max(this.minuteBlockedUntil.get(model) ?? 0, retryAt));
    const seen = this.observations.get(model);
    if (seen) {
      this.observations.set(model, { ...seen, remaining: 0, resetAt: Math.max(seen.resetAt, retryAt), observedAt: now });
    } else {
      this.observations.set(model, { limit: this.configuredLimit(model), remaining: 0, resetAt: retryAt, observedAt: now });
    }
  }

  /**
   * A 429 on a request-limited model, whatever its body said: the next step of
   * the ladder, or until Pacific midnight when it named the day. A longer
   * `retry-after` wins, and a block already longer is kept.
   */
  private backOff(model: string, retryAfterSeconds: number, daily: boolean): void {
    const now = this.now();
    const step = this.backoffStep.get(model) ?? 0;
    this.backoffStep.set(model, step + 1);
    const minutes = RATE_BACKOFF_MINUTES[Math.min(step, RATE_BACKOFF_MINUTES.length - 1)]!;
    let until = now + Math.max(minutes * 60_000, retryAfterSeconds * 1000);
    if (daily) until = Math.max(until, nextQuotaMidnight(now));
    this.exhaustedUntil.set(model, Math.max(this.exhaustedUntil.get(model) ?? 0, until));
  }
}

/** The response schema's size, measured once: it rides on every parser call. */
let schemaChars: number | null = null;

/** A parser call's reservation: its prompt and schema at the estimator's rate, plus its whole completion. */
export function estimateParserTokens(input: PromptInput): number {
  const { system, user } = buildPrompt(input);
  schemaChars ??= JSON.stringify(buildResponseSchema()).length;
  return Math.ceil((system.length + user.length + schemaChars) / CHARS_PER_TOKEN) + PARSER_MAX_COMPLETION_TOKENS;
}

/**
 * The parser fallback runs on the same models, so it spends from the same
 * budget (plan K3). Wrapped once per message (§2b): a model that cannot take
 * the call now, or refused this message already, is skipped without a fetch,
 * and one that answers 429 joins the message's refused set.
 *
 * The parser's own repair retry (`src/nlu/groq.ts`) is inside one `parse` and is
 * not reserved separately; a 429 on it falls through the chain like any other.
 */
export function meterParsers(
  providers: readonly NluProvider[],
  budget: TokenBudget,
  scope: MessageScope = newMessageScope(),
): NluProvider[] {
  return providers.map((provider) => {
    const model = provider.name.startsWith('groq:') ? provider.name.slice('groq:'.length) : null;
    if (model === null) return provider;

    return {
      name: provider.name,
      async parse(input) {
        if (scope.refused.has(model)) {
          return { ok: false, error: { code: 'rate_limited', status: 429 } };
        }
        const reservation = budget.reserve(model, estimateParserTokens(input));
        if (!reservation) {
          scope.refused.add(model);
          return { ok: false, error: { code: 'rate_limited', status: 429 } };
        }
        let response;
        try {
          response = await provider.parse(input);
        } catch (error) {
          budget.chargeUnanswered(reservation);
          throw error;
        }
        if (response.ok) {
          budget.settle(reservation, response.usage.promptTokens + response.usage.completionTokens);
        } else if (response.error.code === 'rate_limited') {
          budget.refused(reservation, response.error.retryAfterSeconds);
          scope.refused.add(model);
        } else if (wasNeverSent(response.error)) {
          budget.release(reservation);
        } else {
          budget.chargeUnanswered(reservation);
        }
        return response;
      },
    };
  });
}

/** Failures that happen before a byte leaves: nothing can have been billed. */
export function wasNeverSent(error: { code: string; cause?: string }): boolean {
  if (error.code === 'not_configured') return true;
  return error.code === 'network_error' && (error.cause === 'ECONNREFUSED' || error.cause === 'ENOTFOUND');
}
