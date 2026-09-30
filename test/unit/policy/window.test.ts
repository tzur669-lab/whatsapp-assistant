/**
 * The 24-hour window and the monthly budget (PLAN §6.1, §6.7, §5).
 *
 * Meta only lets a business reply inside 24 hours of the user's last message,
 * and from 2026-10-01 each number gets 1,000 free service messages a month with
 * no card on file — so running out means delivery simply stops. Both are
 * therefore correctness concerns, not reporting ones: a reminder that cannot be
 * delivered on WhatsApp has to be routed to the Calendar fallback *before* it
 * is due, not discovered at send time.
 */
import { describe, expect, it } from 'vitest';
import {
  WINDOW_MS,
  planDelivery,
  windowClosesAt,
  isWindowOpen,
  budgetState,
  FREE_MESSAGES_PER_MONTH,
  BUDGET_WARN_AT,
} from '../../../src/policy/window.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const HOUR = 60 * 60_000;
const MINUTE = 60_000;

describe('windowClosesAt', () => {
  it('is 24 hours after the last inbound message', () => {
    expect(windowClosesAt(NOW)).toBe(NOW + WINDOW_MS);
  });

  it('is null when the user has never written', () => {
    expect(windowClosesAt(null)).toBeNull();
  });
});

describe('isWindowOpen', () => {
  it('is open just before the deadline', () => {
    expect(isWindowOpen(NOW, NOW + WINDOW_MS - 1)).toBe(true);
  });

  it('is closed exactly at the deadline', () => {
    expect(isWindowOpen(NOW, NOW + WINDOW_MS)).toBe(false);
  });

  it('is closed when the user has never written', () => {
    expect(isWindowOpen(null, NOW)).toBe(false);
  });
});

describe('planDelivery', () => {
  const plan = (dueInHours: number, lastInboundAt: number | null = NOW) =>
    planDelivery({
      dueAtUtc: NOW + dueInHours * HOUR,
      lastInboundAt,
      nowMs: NOW,
      monthlySent: 0,
    });

  it('sends on WhatsApp when the reminder is due well inside the window', () => {
    expect(plan(2)).toMatchObject({ channel: 'whatsapp' });
  });

  it('falls back to the calendar when the reminder is due after the window closes', () => {
    expect(plan(30)).toMatchObject({ channel: 'calendar', reason: 'window_closed' });
  });

  it('falls back within the five minute margin before the window closes', () => {
    // A reminder due 2 minutes before the deadline is too close to trust.
    const dueAt = NOW + WINDOW_MS - 2 * MINUTE;
    const res = planDelivery({ dueAtUtc: dueAt, lastInboundAt: NOW, nowMs: NOW, monthlySent: 0 });
    expect(res).toMatchObject({ channel: 'calendar', reason: 'window_closed' });
  });

  it('still sends when just outside that margin', () => {
    const dueAt = NOW + WINDOW_MS - 10 * MINUTE;
    const res = planDelivery({ dueAtUtc: dueAt, lastInboundAt: NOW, nowMs: NOW, monthlySent: 0 });
    expect(res).toMatchObject({ channel: 'whatsapp' });
  });

  it('falls back when the user has never written', () => {
    expect(plan(1, null)).toMatchObject({ channel: 'calendar', reason: 'window_closed' });
  });

  it('falls back when the monthly budget is spent, whatever the window says', () => {
    const res = planDelivery({
      dueAtUtc: NOW + HOUR,
      lastInboundAt: NOW,
      nowMs: NOW,
      monthlySent: FREE_MESSAGES_PER_MONTH,
    });
    expect(res).toMatchObject({ channel: 'calendar', reason: 'budget_exhausted' });
  });

  it('reports the budget as the reason even when the window is also closed', () => {
    // The user should be told the more actionable of the two.
    const res = planDelivery({
      dueAtUtc: NOW + 30 * HOUR,
      lastInboundAt: NOW,
      nowMs: NOW,
      monthlySent: FREE_MESSAGES_PER_MONTH,
    });
    expect(res).toMatchObject({ channel: 'calendar', reason: 'budget_exhausted' });
  });

  it('says when the plan should be re-checked, so a later message can reopen it', () => {
    const res = plan(30);
    expect(res.recheckAt).toBe(NOW + 30 * HOUR - 10 * MINUTE);
  });

  it('does not schedule a re-check for a delivery it is already sure of', () => {
    expect(plan(2).recheckAt).toBeNull();
  });
});

describe('budgetState', () => {
  it('is ok well under the limit', () => {
    expect(budgetState(100)).toMatchObject({ level: 'ok', remaining: 900 });
  });

  it('warns at the threshold', () => {
    expect(budgetState(BUDGET_WARN_AT)).toMatchObject({ level: 'warn' });
  });

  it('is exhausted at the limit', () => {
    expect(budgetState(FREE_MESSAGES_PER_MONTH)).toMatchObject({
      level: 'exhausted',
      remaining: 0,
    });
  });

  it('never reports a negative remaining', () => {
    expect(budgetState(FREE_MESSAGES_PER_MONTH + 50)).toMatchObject({
      level: 'exhausted',
      remaining: 0,
    });
  });

  it('warns exactly once, at the crossing', () => {
    expect(budgetState(BUDGET_WARN_AT - 1).shouldWarn).toBe(false);
    expect(budgetState(BUDGET_WARN_AT).shouldWarn).toBe(true);
    expect(budgetState(BUDGET_WARN_AT + 1).shouldWarn).toBe(false);
  });
});

describe('planDelivery on the app channel (§6.18)', () => {
  it('goes to the phone whatever the window or the budget says', () => {
    const plan = planDelivery({
      dueAtUtc: Date.UTC(2026, 9, 10, 9, 0, 0),
      lastInboundAt: null,
      nowMs: Date.UTC(2026, 8, 29, 9, 0, 0),
      monthlySent: FREE_MESSAGES_PER_MONTH,
      channel: 'app',
    });
    expect(plan).toEqual({ channel: 'app', reason: 'app', recheckAt: null });
  });
});
