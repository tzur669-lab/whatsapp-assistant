/**
 * Quotas, for the app's quota screen (2026-10-01).
 *
 * Two kinds of number, and the report keeps them apart:
 *
 * - **What Groq says.** Every Groq response carries `x-ratelimit-*` headers:
 *   the day's request bucket and the minute's token bucket, with how long until
 *   each refills. They count everything on the key — the evals run from a
 *   laptop included. Read from headers only; a body is never read (§7.1).
 * - **What this server counts.** Groq's 200K daily token limit is in no
 *   header (PLAN §2, verified 2026-09-24), so the tokens each response billed
 *   are summed here over a rolling 24 hours — which misses anything spent on
 *   the same key elsewhere. Cloudflare's daily requests are counted the same
 *   way, per UTC day.
 *
 * Plain SQL and standard `fetch` only, so this runs on Node too (invariant 11).
 */
import type { SqlDriver } from './sql.js';

/** Groq's free tier, per model (PLAN §2): tokens per rolling day. */
export const DAY_TOKEN_LIMIT = 200_000;
/** Cloudflare Workers Free (PLAN §2), per UTC day. */
export const WORKER_REQUESTS_PER_DAY = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const GROQ_HOST = 'https://api.groq.com/';

export type Bucket = { limit: number; remaining: number; resetAt: number };
export type RateLimits = { requests?: Bucket; minuteTokens?: Bucket };

/** Groq writes durations as `7.66s`, `2m59.56s`, `1h2m3s` or `250ms`. */
export function parseGroqDuration(value: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value.trim());
  if (!match || value.trim() === '' || match.slice(1).every((part) => part === undefined)) return null;
  const [, h, m, s, ms] = match;
  return Math.round(
    Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1_000 + Number(ms ?? 0),
  );
}

function bucketOf(headers: Headers, kind: 'requests' | 'tokens', nowMs: number): Bucket | undefined {
  const limit = Number(headers.get(`x-ratelimit-limit-${kind}`));
  const remaining = Number(headers.get(`x-ratelimit-remaining-${kind}`));
  const reset = parseGroqDuration(headers.get(`x-ratelimit-reset-${kind}`) ?? '');
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(remaining) || remaining < 0 || reset === null) {
    return undefined;
  }
  return { limit, remaining: Math.min(remaining, limit), resetAt: nowMs + reset };
}

/** Both buckets from one response's headers; null when it carried neither. */
export function readRateLimits(headers: Headers, nowMs: number): RateLimits | null {
  const requests = bucketOf(headers, 'requests', nowMs);
  const minuteTokens = bucketOf(headers, 'tokens', nowMs);
  if (!requests && !minuteTokens) return null;
  return { ...(requests ? { requests } : {}), ...(minuteTokens ? { minuteTokens } : {}) };
}

/** The model a Groq request names: a JSON body's `model`, or a form's (Whisper). */
function modelOf(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (typeof body === 'string') {
    const match = /"model"\s*:\s*"([^"]{1,100})"/.exec(body);
    return match?.[1] ?? null;
  }
  if (body instanceof FormData) {
    const model = body.get('model');
    return typeof model === 'string' && model.length <= 100 ? model : null;
  }
  return null;
}

/**
 * A `fetch` that notes Groq's rate-limit headers on the way back, for every
 * Groq call — the parser's, the agent's and Whisper's — in one place. Anything
 * not to Groq passes untouched. The response is returned as it came.
 */
export function meterGroqFetch(
  fetchImpl: typeof fetch,
  record: (model: string, limits: RateLimits) => void,
  now: () => number,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Called as a plain function: Workers' fetch refuses a `this`.
    const response = await fetchImpl(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(GROQ_HOST)) {
      const model = modelOf(init);
      const limits = readRateLimits(response.headers, now());
      if (model && limits) {
        try {
          record(model, limits);
        } catch {
          // A quota display is never worth failing the call it describes.
        }
      }
    }
    return response;
  }) as typeof fetch;
}

export type ModelSpec = {
  model: string;
  role: 'primary' | 'fallback' | 'voice';
  /** Whether Groq's daily token limit applies (not to Whisper, which is billed in audio). */
  dayTokens: boolean;
};

export type ReportedBucket = Bucket & { observedAt: number };

export type QuotaReport = {
  at: number;
  models: Array<{
    model: string;
    role: ModelSpec['role'];
    /** From Groq. Null until a response has carried it. */
    requests: ReportedBucket | null;
    minuteTokens: ReportedBucket | null;
    /** Counted here, over the last 24 hours. */
    dayTokens: { limit: number; used: number } | null;
  }>;
  /** This server's own cap on recordings (§6.10), over the last hour. */
  voice: { used: number; limit: number };
  /** Counted here, per UTC day. */
  workerRequests: { limit: number; used: number; resetAt: number };
};

export class QuotaStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** The latest headers for a model. A bucket a response did not carry keeps its last value. */
  recordLimits(model: string, limits: RateLimits): void {
    const at = this.now();
    const { requests, minuteTokens } = limits;
    this.sql.exec(
      `INSERT INTO groq_limits (model,
         limit_requests, remaining_requests, reset_requests_at, requests_seen_at,
         limit_tokens, remaining_tokens, reset_tokens_at, tokens_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET
         limit_requests     = COALESCE(excluded.limit_requests, limit_requests),
         remaining_requests = COALESCE(excluded.remaining_requests, remaining_requests),
         reset_requests_at  = COALESCE(excluded.reset_requests_at, reset_requests_at),
         requests_seen_at   = COALESCE(excluded.requests_seen_at, requests_seen_at),
         limit_tokens       = COALESCE(excluded.limit_tokens, limit_tokens),
         remaining_tokens   = COALESCE(excluded.remaining_tokens, remaining_tokens),
         reset_tokens_at    = COALESCE(excluded.reset_tokens_at, reset_tokens_at),
         tokens_seen_at     = COALESCE(excluded.tokens_seen_at, tokens_seen_at)`,
      model,
      requests?.limit ?? null,
      requests?.remaining ?? null,
      requests?.resetAt ?? null,
      requests ? at : null,
      minuteTokens?.limit ?? null,
      minuteTokens?.remaining ?? null,
      minuteTokens?.resetAt ?? null,
      minuteTokens ? at : null,
    );
  }

  /** Tokens a response billed: prompt plus completion, reasoning included. */
  recordTokens(model: string, tokens: number): void {
    if (!(tokens > 0)) return;
    this.sql.exec('INSERT INTO groq_token_spend (model, tokens, at) VALUES (?, ?, ?)', model, Math.round(tokens), this.now());
  }

  /** One request reached this object. */
  countRequest(): void {
    this.sql.exec(
      `INSERT INTO worker_requests (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1`,
      utcDay(this.now()),
    );
  }

  report(models: readonly ModelSpec[], voice: { used: number; limit: number }): QuotaReport {
    const now = this.now();
    this.sql.exec('DELETE FROM groq_token_spend WHERE at <= ?', now - DAY_MS);
    this.sql.exec('DELETE FROM worker_requests WHERE day < ?', utcDay(now - DAY_MS));

    return {
      at: now,
      models: models.map((spec) => {
        const row = this.sql.exec('SELECT * FROM groq_limits WHERE model = ?', spec.model)[0];
        const used = Number(
          this.sql.exec('SELECT COALESCE(SUM(tokens), 0) AS used FROM groq_token_spend WHERE model = ?', spec.model)[0]?.[
            'used'
          ] ?? 0,
        );
        return {
          model: spec.model,
          role: spec.role,
          requests: row ? bucketFrom(row, 'requests', now) : null,
          minuteTokens: row ? bucketFrom(row, 'tokens', now) : null,
          dayTokens: spec.dayTokens ? { limit: DAY_TOKEN_LIMIT, used } : null,
        };
      }),
      voice,
      workerRequests: {
        limit: WORKER_REQUESTS_PER_DAY,
        used: Number(this.sql.exec('SELECT count FROM worker_requests WHERE day = ?', utcDay(now))[0]?.['count'] ?? 0),
        resetAt: Date.parse(`${utcDay(now + DAY_MS)}T00:00:00Z`),
      },
    };
  }
}

/**
 * A stored bucket as of now. Past the time Groq gave for it to refill, it is
 * full again — the minute's tokens, most often, between two messages.
 */
function bucketFrom(row: Record<string, unknown>, kind: 'requests' | 'tokens', now: number): ReportedBucket | null {
  const limit = row[`limit_${kind}`];
  const remaining = row[`remaining_${kind}`];
  const resetAt = row[`reset_${kind}_at`];
  const seenAt = row[`${kind}_seen_at`];
  if (limit === null || remaining === null || resetAt === null || seenAt === null) return null;
  const bucket = { limit: Number(limit), remaining: Number(remaining), resetAt: Number(resetAt), observedAt: Number(seenAt) };
  return now >= bucket.resetAt ? { ...bucket, remaining: bucket.limit } : bucket;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
