/**
 * Request limits in the budget (smart conversations, slice 2): a model that
 * declares `minuteRequests` / `dayRequests` (Gemini) is counted in requests
 * too, and backs off on every 429. Groq models keep exactly today's behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryDayRequestCounter,
  nextQuotaMidnight,
  quotaDay,
  TokenBudget,
} from '../../../src/agent/budget.js';
import type { DayRequestCounter } from '../../../src/agent/budget.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { SqlDayRequestCounter } from '../../../src/core/quota.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const GEMINI = SMART_MODELS[0]!;
const MINUTE = 60_000;
/** 12:00 in Israel, 02:00 in California (PDT): the Pacific day is 2026-10-08. */
const NOON = Date.parse('2026-10-08T09:00:00Z');

function clock(start = NOON) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) };
}

/** A counter that records every touch, to prove Groq never reaches it. */
function spyCounter(): DayRequestCounter & { touched: number } {
  const inner = new MemoryDayRequestCounter();
  return {
    touched: 0,
    get(day, model) {
      this.touched++;
      return inner.get(day, model);
    },
    bump(day, model, delta) {
      this.touched++;
      inner.bump(day, model, delta);
    },
  };
}

/** One sent, answered request. */
function call(budget: TokenBudget, model = GEMINI.id): void {
  const reservation = budget.reserve(model, 100);
  if (!reservation) throw new Error('did not fit');
  budget.settle(reservation, 100);
}

describe('the Pacific quota day', () => {
  it('keys the day by California midnight, not UTC or Israel', () => {
    expect(quotaDay(Date.parse('2026-10-08T06:59:00Z'))).toBe('2026-10-07'); // 23:59 PDT
    expect(quotaDay(Date.parse('2026-10-08T07:00:00Z'))).toBe('2026-10-08'); // 00:00 PDT
  });

  it('finds the next California midnight, across the November fall-back', () => {
    expect(nextQuotaMidnight(NOON)).toBe(Date.parse('2026-10-09T07:00:00Z'));
    // 2026-11-01 is the fall-back day in Los Angeles: the next midnight is PST.
    expect(nextQuotaMidnight(Date.parse('2026-11-01T12:00:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z'));
  });
});

describe('requests per minute', () => {
  it('caps calls in the sliding minute at the entry’s minuteRequests', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    for (let i = 0; i < GEMINI.minuteRequests!; i++) call(budget);
    expect(budget.fits(GEMINI.id, 100)).toBe(false);
    expect(budget.reserve(GEMINI.id, 100)).toBeNull();
    c.advance(MINUTE + 1);
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });

  it('counts calls still in flight', () => {
    const budget = new TokenBudget(clock().now);
    for (let i = 0; i < GEMINI.minuteRequests!; i++) expect(budget.reserve(GEMINI.id, 100)).not.toBeNull();
    expect(budget.reserve(GEMINI.id, 100)).toBeNull();
  });
});

describe('requests per day', () => {
  it('counts each reservation, and refuses at the entry’s dayRequests', () => {
    const counter = new MemoryDayRequestCounter();
    const day = quotaDay(NOON);
    for (let i = 0; i < GEMINI.dayRequests! - 1; i++) counter.bump(day, GEMINI.id, 1);
    const budget = new TokenBudget(clock().now, undefined, counter);
    expect(budget.reserve(GEMINI.id, 100)).not.toBeNull();
    expect(counter.get(day, GEMINI.id)).toBe(GEMINI.dayRequests);
    expect(budget.fits(GEMINI.id, 100)).toBe(false);
  });

  it('gives a request back when it was never sent, and keeps it when it was', () => {
    const counter = new MemoryDayRequestCounter();
    const budget = new TokenBudget(clock().now, undefined, counter);
    const day = quotaDay(NOON);

    const unsent = budget.reserve(GEMINI.id, 100)!;
    expect(counter.get(day, GEMINI.id)).toBe(1);
    budget.release(unsent);
    expect(counter.get(day, GEMINI.id)).toBe(0);

    budget.settle(budget.reserve(GEMINI.id, 100)!, 50);
    budget.chargeUnanswered(budget.reserve(GEMINI.id, 100)!);
    budget.refused(budget.reserve(GEMINI.id, 100)!, undefined);
    expect(counter.get(day, GEMINI.id)).toBe(3);
  });

  it('gives a request back to the day it was taken from, even after midnight', () => {
    const c = clock(Date.parse('2026-10-09T06:59:30Z')); // 23:59:30 PDT
    const counter = new MemoryDayRequestCounter();
    const budget = new TokenBudget(c.now, undefined, counter);
    const reservation = budget.reserve(GEMINI.id, 100)!;
    c.advance(MINUTE);
    budget.release(reservation);
    expect(counter.get('2026-10-08', GEMINI.id)).toBe(0);
    expect(counter.get('2026-10-09', GEMINI.id)).toBe(0);
  });

  it('starts over at California midnight', () => {
    const c = clock(Date.parse('2026-10-09T06:00:00Z')); // 23:00 PDT
    const counter = new MemoryDayRequestCounter();
    for (let i = 0; i < GEMINI.dayRequests!; i++) counter.bump(quotaDay(c.now()), GEMINI.id, 1);
    const budget = new TokenBudget(c.now, undefined, counter);
    expect(budget.fits(GEMINI.id, 100)).toBe(false);
    c.set(Date.parse('2026-10-09T07:00:00Z'));
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });

  it('survives the object being evicted: the count lives in SQLite', () => {
    const driver = new TestSqlDriver();
    try {
      new Repository(driver).migrate(MIGRATIONS);
      const c = clock();
      const first = new TokenBudget(c.now, undefined, new SqlDayRequestCounter(driver));
      call(first);
      call(first);
      // A new object, a new budget in memory, the same table.
      const counter = new SqlDayRequestCounter(driver);
      expect(counter.get(quotaDay(NOON), GEMINI.id)).toBe(2);
      const second = new TokenBudget(c.now, undefined, counter);
      const reservation = second.reserve(GEMINI.id, 100)!;
      expect(counter.get(quotaDay(NOON), GEMINI.id)).toBe(3);
      second.release(reservation);
      expect(counter.get(quotaDay(NOON), GEMINI.id)).toBe(2);
    } finally {
      driver.close();
    }
  });
});

describe('the SQLite day counter', () => {
  it('never goes below zero, and forgets earlier days as a new one starts', () => {
    const driver = new TestSqlDriver();
    try {
      new Repository(driver).migrate(MIGRATIONS);
      const counter = new SqlDayRequestCounter(driver);
      counter.bump('2026-10-07', 'm', 1);
      counter.bump('2026-10-07', 'm', -1);
      counter.bump('2026-10-07', 'm', -1);
      expect(counter.get('2026-10-07', 'm')).toBe(0);
      counter.bump('2026-10-07', 'm', 1);
      counter.bump('2026-10-08', 'm', 1);
      expect(counter.get('2026-10-08', 'm')).toBe(1);
      expect(driver.exec('SELECT day FROM model_day_requests').map((row) => row['day'])).toEqual(['2026-10-08']);
      // A late give-back to a day already forgotten writes nothing.
      counter.bump('2026-10-07', 'm', -1);
      expect(driver.exec('SELECT COUNT(*) AS n FROM model_day_requests')[0]?.['n']).toBe(1);
    } finally {
      driver.close();
    }
  });
});

describe('429 backoff for a request-limited model', () => {
  afterEach(() => vi.useRealTimers());

  it('blocks for 1, 2, 5, then 10 minutes, whatever the body said', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    for (const minutes of [1, 2, 5, 10, 10]) {
      budget.refused(budget.reserve(GEMINI.id, 100)!, undefined);
      c.advance(minutes * MINUTE - 1);
      expect(budget.fits(GEMINI.id, 100)).toBe(false);
      c.advance(1);
      expect(budget.fits(GEMINI.id, 100)).toBe(true);
    }
  });

  it('starts the ladder over after a success', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited(GEMINI.id, undefined);
    c.advance(MINUTE);
    budget.rateLimited(GEMINI.id, undefined);
    c.advance(2 * MINUTE);
    call(budget);
    budget.rateLimited(GEMINI.id, undefined);
    c.advance(MINUTE);
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });

  it('waits out a longer retry-after', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited(GEMINI.id, 90);
    c.advance(89_999);
    expect(budget.fits(GEMINI.id, 100)).toBe(false);
    c.advance(1);
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });

  it('blocks until California midnight when the 429 named the day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    const budget = new TokenBudget(() => Date.now());
    budget.refused(budget.reserve(GEMINI.id, 100)!, undefined, 'day');
    const midnight = Date.parse('2026-10-09T07:00:00Z');
    expect(budget.snapshot([GEMINI.id])[0]?.blockedUntil).toBe(midnight);
    vi.setSystemTime(midnight - 1);
    expect(budget.fits(GEMINI.id, 100)).toBe(false);
    vi.setSystemTime(midnight);
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });
});

describe('Groq models are untouched', () => {
  it('never reaches the day counter, and has no request cap', () => {
    const counter = spyCounter();
    const budget = new TokenBudget(clock().now, undefined, counter);
    for (let i = 0; i < 50; i++) {
      const reservation = budget.reserve(QWEN, 10)!;
      expect(reservation).not.toBeNull();
      budget.release(reservation);
    }
    for (let i = 0; i < 50; i++) call(budget, QWEN);
    budget.fits(QWEN, 10);
    expect(counter.touched).toBe(0);
  });

  it('keeps the retry-after rule on a 429: no ladder, and "day" means the time given', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited(QWEN, 2);
    c.advance(MINUTE + 1);
    expect(budget.fits(QWEN, 100)).toBe(true);
    budget.rateLimited(QWEN, 2);
    c.advance(MINUTE + 1);
    // Not 2 minutes: Groq models never escalate.
    expect(budget.fits(QWEN, 100)).toBe(true);

    budget.rateLimited(QWEN, 120, 'day');
    expect(budget.snapshot([QWEN])[0]?.blockedUntil).toBe(c.now() + 120_000);
  });
});

describe('a smart model that is overloaded (503/500, 2026-10-08)', () => {
  it('rests on the 429 ladder, never until midnight, and starts over after a success', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    for (const minutes of [1, 2, 5, 10, 10]) {
      budget.refused(budget.reserve(GEMINI.id, 100)!, undefined, 'overloaded');
      expect(budget.snapshot([GEMINI.id])[0]?.blockedUntil).toBe(c.now() + minutes * MINUTE);
      c.advance(minutes * MINUTE - 1);
      expect(budget.fits(GEMINI.id, 100)).toBe(false);
      c.advance(1);
      expect(budget.fits(GEMINI.id, 100)).toBe(true);
    }
    call(budget);
    budget.rateLimited(GEMINI.id, undefined, 'overloaded');
    c.advance(MINUTE);
    expect(budget.fits(GEMINI.id, 100)).toBe(true);
  });

  it('keeps the request it spent: it was sent', () => {
    const counter = new MemoryDayRequestCounter();
    const budget = new TokenBudget(clock().now, undefined, counter);
    budget.refused(budget.reserve(GEMINI.id, 100)!, undefined, 'overloaded');
    expect(counter.get(quotaDay(NOON), GEMINI.id)).toBe(1);
  });
});
