/**
 * Proactive calendar suggestions (block L, L3): which events are suggested,
 * the store's lease and token fencing, and the tap end to end through
 * `runButton` with a fake calendar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { eventsToSuggest, localDay, placesOverlap } from '../../../src/core/suggest-plan.js';
import { SuggestionStore, SUGGESTION_LEASE_MS, SUGGESTION_TAP_MS } from '../../../src/tools/suggestion-store.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, buttonId, parseButtonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { runButton } from '../../../src/core/orchestrator.js';
import type { TurnContext } from '../../../src/core/orchestrator.js';
import { createLogger } from '../../../src/security/redact.js';
import type { CalendarEvent } from '../../../src/google/calendar.js';
import type { ToolContext } from '../../../src/tools/types.js';

const ME = 'p_me0000000000';
const HOUR = 60 * 60 * 1000;

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'e1', title: 'פגישה עם דנה', startUtc: 0, endUtc: 0, allDay: false, createdByAssistant: false, etag: null, location: 'הרצל 5, תל אביב', ...overrides };
}

describe('localDay', () => {
  it('tomorrow in Jerusalem, as a key and its UTC bounds', () => {
    const now = Date.UTC(2026, 9, 15, 7, 0); // 10:00 local
    const day = localDay(now, 1);
    expect(day.key).toBe('2026-10-16');
    expect(day.startUtc).toBe(Date.UTC(2026, 9, 15, 21, 0));
    expect(day.endUtc).toBe(Date.UTC(2026, 9, 16, 21, 0));
  });

  it('the fall-back day (2026-10-25) is 25 hours long', () => {
    const day = localDay(Date.UTC(2026, 9, 24, 7, 0), 1);
    expect(day.key).toBe('2026-10-25');
    expect(day.endUtc - day.startUtc).toBe(25 * HOUR);
  });
});

describe('eventsToSuggest', () => {
  const now = Date.UTC(2026, 9, 15, 7, 0);
  const day = localDay(now, 1);
  const at = (hourLocal: number) => day.startUtc + hourLocal * HOUR;
  const pick = (events: CalendarEvent[], leaves: Parameters<typeof eventsToSuggest>[0]['leaves'] = [], already = new Set<string>()) =>
    eventsToSuggest({ events, leaves, already, day, nowMs: now }).map((e) => e.id);

  it('timed events with a place, tomorrow, soonest first, at most three', () => {
    const events = [5, 1, 4, 2, 3].map((n) => event({ id: `e${n}`, startUtc: at(8 + n) }));
    expect(pick(events)).toEqual(['e1', 'e2', 'e3']);
  });

  it('skips all-day events, place-less ones, other days, and ones already suggested', () => {
    expect(
      pick(
        [
          event({ id: 'all', allDay: true, startUtc: at(0) }),
          event({ id: 'none', location: '  ', startUtc: at(9) }),
          event({ id: 'today', startUtc: now + HOUR }),
          event({ id: 'after', startUtc: day.endUtc }),
          event({ id: 'seen', startUtc: at(10) }),
          event({ id: 'ok', startUtc: at(11) }),
        ],
        [],
        new Set(['seen']),
      ),
    ).toEqual(['ok']);
  });

  it('an event with a linked leave reminder is not suggested', () => {
    expect(pick([event({ startUtc: at(10) })], [{ eventId: 'e1', place: 'x', dueAtUtc: at(9) }])).toEqual([]);
  });

  it('an older reminder overlapping by place in the 3 hours before: skipped (fail safe)', () => {
    const e = event({ startUtc: at(10) });
    expect(pick([e], [{ eventId: null, place: 'הרצל 5, תל אביב', dueAtUtc: at(9) }])).toEqual([]);
    expect(pick([e], [{ eventId: null, place: 'הרצל 5', dueAtUtc: at(8) }])).toEqual([]);
    // Too early, or another place: no overlap, suggested.
    expect(pick([e], [{ eventId: null, place: 'הרצל 5', dueAtUtc: at(6) }])).toEqual(['e1']);
    expect(pick([e], [{ eventId: null, place: 'דיזנגוף 100', dueAtUtc: at(9) }])).toEqual(['e1']);
  });

  it('placesOverlap: equal or contained, case and spaces folded; empty never overlaps', () => {
    expect(placesOverlap('Herzl  5', 'herzl 5, Tel Aviv')).toBe(true);
    expect(placesOverlap('', 'x')).toBe(false);
  });
});

let driver: TestSqlDriver;
let store: SuggestionStore;
let now = Date.UTC(2026, 9, 15, 7, 0);

beforeEach(() => {
  now = Date.UTC(2026, 9, 15, 7, 0);
  driver = new TestSqlDriver();
  new Repository(driver).migrate(MIGRATIONS);
  store = new SuggestionStore(driver, () => now);
});
afterEach(() => driver.close());

function offered(eventIds = ['e1']): Array<{ id: string; nonce: string }> {
  const out: Array<{ id: string; nonce: string }> = [];
  store.offer(ME, '2026-10-16', eventIds, (_eventId, id, nonce) => out.push({ id, nonce }));
  return out;
}
const statusOf = (id: string) => String(driver.exec('SELECT status FROM suggestions WHERE id = ?', id)[0]?.['status']);

describe('SuggestionStore', () => {
  it('a rerun of the day inserts nothing and sends nothing', () => {
    expect(offered()).toHaveLength(1);
    expect(offered()).toHaveLength(0);
  });

  it('a guard that says no writes nothing', () => {
    let notices = 0;
    expect(store.offer(ME, '2026-10-16', ['e1'], () => notices++, () => false)).toBe(0);
    expect(notices).toBe(0);
    expect(driver.exec('SELECT * FROM suggestions')).toHaveLength(0);
  });

  it('a throw in a notice rolls back the row', () => {
    expect(() =>
      store.offer(ME, '2026-10-16', ['e1'], () => {
        throw new Error('outbox down');
      }),
    ).toThrow();
    expect(driver.exec('SELECT * FROM suggestions')).toHaveLength(0);
  });

  it('a claimed row is held: a second tap is gone until the lease expires', () => {
    const [s] = offered();
    const first = store.claim(ME, s!.id, s!.nonce);
    expect(first.kind).toBe('claimed');
    expect(store.claim(ME, s!.id, s!.nonce).kind).toBe('gone');
    now += SUGGESTION_LEASE_MS + 1;
    expect(store.claim(ME, s!.id, s!.nonce).kind).toBe('claimed');
  });

  it('a superseded claim changes nothing: complete, close and release all refuse its token', () => {
    const [s] = offered();
    const stale = store.claim(ME, s!.id, s!.nonce);
    now += SUGGESTION_LEASE_MS + 1;
    const fresh = store.claim(ME, s!.id, s!.nonce);
    if (stale.kind !== 'claimed' || fresh.kind !== 'claimed') throw new Error('claims');
    let issued = 0;
    expect(store.complete(s!.id, stale.token, () => ({ pendingId: `p${++issued}` }))).toBeNull();
    expect(store.close(s!.id, stale.token)).toBe(false);
    expect(store.release(s!.id, stale.token)).toBe(false);
    expect(issued).toBe(0);
    expect(statusOf(s!.id)).toBe('checking');
    expect(store.complete(s!.id, fresh.token, () => ({ pendingId: 'p-fresh' }))).toEqual({ pendingId: 'p-fresh' });
    expect(statusOf(s!.id)).toBe('used');
  });

  it('wrong nonce, another principal, or an old notice is gone; no dismisses once', () => {
    const [s] = offered();
    expect(store.claim(ME, s!.id, 'ab'.repeat(16)).kind).toBe('gone');
    expect(store.claim('p_other0000000', s!.id, s!.nonce).kind).toBe('gone');
    expect(store.dismiss(ME, s!.id, s!.nonce)).toBe(true);
    expect(store.dismiss(ME, s!.id, s!.nonce)).toBe(false);
    const [t] = offered(['e2']);
    now += SUGGESTION_TAP_MS + 1;
    expect(store.claim(ME, t!.id, t!.nonce).kind).toBe('gone');
  });
});

describe('the suggestion tap (runButton sg:)', () => {
  let pending: PendingActions;
  let reminders: ReminderStore;
  let repo: Repository;
  let calendarEvent: { ok: true; value: CalendarEvent } | { ok: false; error: { code: string } };

  beforeEach(() => {
    pending = new PendingActions(driver, () => now);
    reminders = new ReminderStore(driver, () => now);
    repo = new Repository(driver);
    calendarEvent = { ok: true, value: event({ startUtc: now + 26 * HOUR }) };
  });

  function turn(): TurnContext {
    const tool = {
      principal: ME,
      nowMs: now,
      lang: 'he',
      repo,
      reminders,
      log: createLogger(),
      lastInboundAt: now,
      monthlySent: 0,
      channel: 'app',
      suggestions: store,
      calendar: { getEvent: async () => calendarEvent },
    } as unknown as ToolContext;
    return { tool, pending, deferred: new UndoActions(driver, () => now), messageSentAtMs: now, forwarded: false, paused: false, source: 'text' };
  }
  const tap = (s: { id: string; nonce: string }, verb: 'ok' | 'no' = 'ok') => runButton(buttonId('sg', s.id, s.nonce, verb), turn());
  const live = () => driver.exec("SELECT id FROM pending_actions WHERE tool = 'reminders.leave' AND status = 'pending'").length;

  it('ok: a reminders.leave card for the event as it is now, tainted; the row is used', async () => {
    const [s] = offered();
    const reply = await tap(s!);
    expect(reply.buttons?.map((b) => parseButtonId(b.id)?.kind)).toEqual(['pa', 'pa']);
    expect(reply.tainting).toBe(true);
    expect(statusOf(s!.id)).toBe('used');
    expect(live()).toBe(1);
  });

  it('a re-tap after a lost reply replaces the card: still one live', async () => {
    const [s] = offered();
    await tap(s!);
    const again = await tap(s!);
    expect(again.buttons).toHaveLength(2);
    expect(live()).toBe(1);
  });

  it('a deleted event closes it; a started one too; no card', async () => {
    const [s, t] = offered(['e1', 'e2']);
    calendarEvent = { ok: false, error: { code: 'not_found' } };
    expect((await tap(s!)).text).toContain('בוטל');
    expect(statusOf(s!.id)).toBe('dismissed');
    calendarEvent = { ok: true, value: event({ startUtc: now - 1000 }) };
    expect((await tap(t!)).text).toContain('כבר התחיל');
    expect(live()).toBe(0);
  });

  it('a calendar error leaves it open for another tap', async () => {
    const [s] = offered();
    calendarEvent = { ok: false, error: { code: 'provider_error' } };
    expect((await tap(s!)).text).toContain('לא הצלחתי');
    expect(statusOf(s!.id)).toBe('open');
  });

  it('too late to leave (the event starts within the travel time): closed, no card', async () => {
    const [s] = offered();
    calendarEvent = { ok: true, value: event({ startUtc: now + 10 * 60 * 1000 }) };
    expect((await tap(s!)).text).toContain('מאוחר');
    expect(statusOf(s!.id)).toBe('dismissed');
    expect(live()).toBe(0);
  });

  it('confirming the card makes one reminder linked to the event; a second card for it is refused at execute', async () => {
    const [s] = offered(['e1']);
    const first = await tap(s!);
    const ok = first.buttons!.find((b) => b.id.endsWith(':ok'))!;
    await runButton(ok.id, turn());
    expect(reminders.hasPendingLeaveFor(ME, 'e1')).toBe(true);
    // Another suggestion row for the same event (another day's): its card refuses at execute.
    const later: Array<{ id: string; nonce: string }> = [];
    store.offer(ME, '2026-10-17', ['e1'], (_e, id, nonce) => later.push({ id, nonce }));
    const second = await tap(later[0]!);
    const ok2 = second.buttons!.find((b) => b.id.endsWith(':ok'))!;
    expect((await runButton(ok2.id, turn())).text).toContain('כבר קיימת');
  });

  it('no dismisses', async () => {
    const [s] = offered();
    expect((await tap(s!, 'no')).text).toContain('בלי תזכורת');
    expect(statusOf(s!.id)).toBe('dismissed');
  });
});
