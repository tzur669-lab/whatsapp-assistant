/**
 * The daily digest (PLAN §6.12, §11.3).
 *
 * The feature field reports rate highest, and the one most easily ruined. A
 * scheduled message fails in exactly one way — by becoming noise — so the cases
 * that matter most here are the ones where nothing is sent at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { buildDigest } from '../../../src/core/digest.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { matchCommand } from '../../../src/core/router.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { endOfLocalDay } from '../../../src/time/range.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

/** Thursday 2026-09-24, 07:00 local (04:00 UTC — Israel is on DST). */
const NOW = Date.parse('2026-09-24T04:00:00Z');
const PRINCIPAL = 'p_digest000000';
const TZ = 'Asia/Jerusalem';

const plain = (text: string | null) => (text === null ? null : stripIsolates(text));

/** A calendar that answers with whatever the test hands it. No network. */
function fakeCalendar(events: CalendarEvent[] | { error: 'unavailable' }): CalendarClient {
  return {
    listAllEvents(...args: unknown[]) {
      return (this as unknown as { listEvents: (...a: unknown[]) => unknown }).listEvents(...args);
    },
    async listEvents() {
      return Array.isArray(events)
        ? { ok: true as const, value: events }
        : { ok: false as const, error: { code: 'unavailable' as const } };
    },
  } as unknown as CalendarClient;
}

function event(startLocalIso: string, title: string): CalendarEvent {
  const start = Date.parse(startLocalIso);
  return {
    id: `e-${start}`,
    title,
    startUtc: start,
    endUtc: start + 3_600_000,
    allDay: false,
    createdByAssistant: false,
    etag: null,
  };
}

describe('buildDigest', () => {
  let driver: TestSqlDriver;
  let reminders: ReminderStore;
  let log: ReturnType<typeof createFakeLogger>;

  const ctx = (calendar?: CalendarClient) => ({
    nowMs: NOW,
    principal: PRINCIPAL,
    lang: 'he' as const,
    reminders,
    log,
    ...(calendar ? { calendar } : {}),
  });

  const schedule = (dueAtUtc: number, text: string) =>
    reminders.schedule({ principal: PRINCIPAL, text, dueAtUtc, localWallTime: '', tz: TZ });

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('sends nothing on a day with nothing on it', async () => {
    // The whole feature depends on this. A digest that says "nothing today"
    // every morning trains the user to dismiss it, and then the real one too.
    expect(await buildDigest(ctx())).toBeNull();
  });

  it('sends nothing rather than an empty brief when the calendar is empty', async () => {
    expect(await buildDigest(ctx(fakeCalendar([])))).toBeNull();
  });

  it('lists today\'s reminders under a greeting that matches the hour', async () => {
    schedule(Date.parse('2026-09-24T11:00:00Z'), 'להתקשר לאבא');

    const text = plain(await buildDigest(ctx()));
    expect(text).toContain('בוקר טוב');
    expect(text).toContain('תזכורות להיום');
    expect(text).toContain('להתקשר לאבא');
    expect(text).toContain('14:00');
  });

  it('leaves out a reminder that is not until tomorrow', async () => {
    schedule(Date.parse('2026-09-25T11:00:00Z'), 'מחר');
    expect(await buildDigest(ctx())).toBeNull();
  });

  it('includes the calendar, from now to the end of the day', async () => {
    const text = plain(
      await buildDigest(ctx(fakeCalendar([event('2026-09-24T06:00:00Z', 'פגישה עם יוסי')]))),
    );
    expect(text).toContain('ביומן');
    expect(text).toContain('פגישה עם יוסי');
  });

  it('asks the calendar only about the rest of today', async () => {
    const asked: { startUtc: number; endUtc: number }[] = [];
    const spy = {
      listAllEvents(...args: unknown[]) {
        return (this as unknown as { listEvents: (...a: unknown[]) => unknown }).listEvents(...args);
      },
      async listEvents(params: { startUtc: number; endUtc: number }) {
        asked.push(params);
        return { ok: true as const, value: [] };
      },
    } as unknown as CalendarClient;

    await buildDigest(ctx(spy));

    // From now, not from midnight: a digest at 14:00 is not a list of the
    // meetings that already happened.
    expect(asked[0]?.startUtc).toBe(NOW);
    expect(asked[0]?.endUtc).toBe(endOfLocalDay(NOW, TZ));
  });

  it('leads the overdue section with what did not arrive', async () => {
    schedule(Date.parse('2026-09-23T18:00:00Z'), 'לשלם חשבון');

    const text = plain(await buildDigest(ctx()));
    expect(text).toContain('לא הגיעו');
    expect(text).toContain('לשלם חשבון');
  });

  it('still sends the reminders when the calendar is down', async () => {
    // A failed calendar read is not worth cancelling the digest over, and
    // "your calendar did not load" is a line the user cannot act on at 07:00.
    schedule(Date.parse('2026-09-24T11:00:00Z'), 'להתקשר לאבא');

    const text = plain(await buildDigest(ctx(fakeCalendar({ error: 'unavailable' }))));
    expect(text).toContain('להתקשר לאבא');
    expect(text).not.toContain('ביומן');
    expect(log.captured.some((line) => line.event === 'digest_calendar_failed')).toBe(true);
  });

  it('logs counts and never a title or a reminder body', async () => {
    schedule(Date.parse('2026-09-24T11:00:00Z'), 'להתקשר לאבא');
    await buildDigest(ctx(fakeCalendar([event('2026-09-24T06:00:00Z', 'פגישה עם יוסי')])));

    const serialized = JSON.stringify(log.captured);
    expect(serialized).not.toContain('להתקשר');
    expect(serialized).not.toContain('יוסי');
    expect(log.captured.some((line) => line.event === 'digest_composed')).toBe(true);
  });
});

describe('the greeting', () => {
  let driver: TestSqlDriver;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it.each([
    ['2026-09-24T04:00:00Z', 'בוקר טוב'],
    ['2026-09-24T11:00:00Z', 'צהריים טובים'],
    ['2026-09-24T17:00:00Z', 'ערב טוב'],
  ])('at %s says %s', async (iso, expected) => {
    const at = Date.parse(iso);
    const reminders = new ReminderStore(driver, () => at);
    reminders.schedule({
      principal: PRINCIPAL,
      text: 'א',
      dueAtUtc: at + 60_000,
      localWallTime: '',
      tz: TZ,
    });

    const text = plain(
      await buildDigest({
        nowMs: at,
        principal: PRINCIPAL,
        lang: 'he',
        reminders,
        log: createFakeLogger(),
      }),
    );
    expect(text).toContain(expected);
  });
});

describe('/digest', () => {
  it('reads an hour off the command', () => {
    expect(matchCommand('/digest 7')).toEqual({ kind: 'digest', set: 7 });
    expect(matchCommand('/digest 0')).toEqual({ kind: 'digest', set: 0 });
    expect(matchCommand('/digest 23')).toEqual({ kind: 'digest', set: 23 });
  });

  it('reports with no argument, and stops with off', () => {
    expect(matchCommand('/digest')).toEqual({ kind: 'digest', set: null });
    expect(matchCommand('/digest off')).toEqual({ kind: 'digest', set: 'off' });
  });

  it('is not a command when the hour is not one', () => {
    // Falling through to the parser is better than clamping 25 to something
    // the user did not ask for.
    expect(matchCommand('/digest 25')).toBeNull();
    expect(matchCommand('/digest 99')).toBeNull();
    expect(matchCommand('/digest tomorrow')).toBeNull();
  });
});

describe('the digest setting', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it('is off until it is set', () => {
    expect(repo.digestHour()).toBeNull();
  });

  it('round-trips an hour and turns off again', () => {
    repo.setDigestHour(7);
    expect(repo.digestHour()).toBe(7);
    repo.setDigestHour(null);
    expect(repo.digestHour()).toBeNull();
  });

  it('reads a corrupted stored hour as off rather than sending at hour NaN', () => {
    repo.setDigestHour(7);
    repo.setSetting('digest_hour', 'lunchtime');
    expect(repo.digestHour()).toBeNull();
  });

  it('remembers which day it has already dealt with', () => {
    expect(repo.digestDoneOn()).toBeNull();
    repo.markDigestDone('2026-09-24');
    expect(repo.digestDoneOn()).toBe('2026-09-24');
  });
});
