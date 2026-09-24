/**
 * The 24-hour service window and the monthly message budget
 * (PLAN §5, §6.1, §6.7).
 *
 * Two hard limits, both outside our control:
 *
 *   - Meta only accepts a free-form reply within 24 hours of the user's last
 *     message. Outside that, nothing gets through except a paid template.
 *   - From 2026-10-01 each number gets 1,000 free service messages a month.
 *     With no payment method on the account — which is the deliberate cost cap
 *     (PLAN §5) — delivery simply stops once they are used.
 *
 * So a reminder due outside the window is not a send that fails; it is a send
 * that must never be attempted. It is routed to a Google Calendar popup
 * instead, and that decision is made when the reminder is created, not when it
 * comes due.
 */

/** Meta's customer-service window. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How close to the deadline is too close. A reminder due inside this margin is
 * routed to the calendar: the few minutes between deciding and sending are
 * enough for the window to shut.
 */
export const WINDOW_MARGIN_MS = 5 * 60 * 1000;

/** How long before a reminder is due to re-check whether the window reopened. */
export const RECHECK_BEFORE_MS = 10 * 60 * 1000;

/** Free service messages per number per month, from 2026-10-01 (PLAN §2). */
export const FREE_MESSAGES_PER_MONTH = 1_000;

/** Where the app warns, leaving room to notice before delivery stops. */
export const BUDGET_WARN_AT = 800;

export type Channel = 'whatsapp' | 'calendar';

export type DeliveryPlan = {
  channel: Channel;
  reason: 'in_window' | 'window_closed' | 'budget_exhausted';
  /**
   * When to look again, for a plan that may still change. A reminder routed to
   * the calendar can come back to WhatsApp if the user writes in the meantime,
   * so the backup event is deleted and the send is planned instead.
   */
  recheckAt: number | null;
};

export function windowClosesAt(lastInboundAt: number | null): number | null {
  return lastInboundAt === null ? null : lastInboundAt + WINDOW_MS;
}

export function isWindowOpen(lastInboundAt: number | null, atMs: number): boolean {
  const closesAt = windowClosesAt(lastInboundAt);
  return closesAt !== null && atMs < closesAt;
}

export function planDelivery(params: {
  dueAtUtc: number;
  lastInboundAt: number | null;
  nowMs: number;
  monthlySent: number;
}): DeliveryPlan {
  // The budget is checked first: it is the more actionable of the two, and
  // unlike the window it will not fix itself when the user writes back.
  if (budgetState(params.monthlySent).level === 'exhausted') {
    return { channel: 'calendar', reason: 'budget_exhausted', recheckAt: null };
  }

  const closesAt = windowClosesAt(params.lastInboundAt);
  const deliverable = closesAt !== null && params.dueAtUtc < closesAt - WINDOW_MARGIN_MS;

  if (deliverable) {
    return { channel: 'whatsapp', reason: 'in_window', recheckAt: null };
  }

  return {
    channel: 'calendar',
    reason: 'window_closed',
    // Worth another look shortly before it is due: any message from the user
    // between now and then reopens the window.
    recheckAt: Math.max(params.nowMs, params.dueAtUtc - RECHECK_BEFORE_MS),
  };
}

export type BudgetLevel = 'ok' | 'warn' | 'exhausted';

export type BudgetState = {
  level: BudgetLevel;
  sent: number;
  remaining: number;
  /** True only on the message that crosses the threshold, so it is said once. */
  shouldWarn: boolean;
};

export function budgetState(monthlySent: number): BudgetState {
  const remaining = Math.max(0, FREE_MESSAGES_PER_MONTH - monthlySent);
  const level: BudgetLevel =
    monthlySent >= FREE_MESSAGES_PER_MONTH ? 'exhausted' : monthlySent >= BUDGET_WARN_AT ? 'warn' : 'ok';

  return {
    level,
    sent: monthlySent,
    remaining,
    shouldWarn: monthlySent === BUDGET_WARN_AT,
  };
}
