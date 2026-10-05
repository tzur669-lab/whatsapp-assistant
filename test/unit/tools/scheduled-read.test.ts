/**
 * Scheduled reads (ROADMAP #7, PLAN §6.7): "send me the weather every morning
 * at 7".
 *
 * A recurring reminder that carries a closed action. The cases that matter:
 * the action survives into every occurrence, nothing off the closed list is
 * ever run, a cancel during the fetch stops the send, and a read held too long
 * is dropped rather than sent stale.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { remindersCancel, remindersList, remindersScheduledRead } from '../../../src/tools/reminders.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import type { ClaimedReminder } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import {
  scheduledReadMessage,
  SCHEDULED_READ_DEADLINE_MS,
  SCHEDULED_READ_MAX_LATE_MS,
} from '../../../src/core/scheduled-read.js';
import type { ScheduledTopic } from '../../../src/nlu/slot-schemas.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { stripIsolates } from '../../../src/render/bidi.js';

/** Thursday 2026-09-24, 12:00 local (09:00Z). */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';
const HOUR = 60 * 60_000;

const at = (hour: number, minute = 0) => ({ hour, minute, meridiem: 'unspecified', part_of_day: 'unspecified' });

type Input = { text: string; dueAtUtc: number; localWallTime: string; rule: Record<string, unknown>; action: string };

describe('reminders.scheduled_read', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let ctx: ToolContext;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => now);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => {
    driver.close();
    vi.useRealTimers();
  });

  const ready = (outcome: ReturnType<typeof remindersScheduledRead.resolve>): Input => {
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('not ready');
    return outcome.input as Input;
  };

  // -- resolve ----------------------------------------------------------------

  it('"the weather every morning at 7": a daily rule with a code-made label', () => {
    const input = ready(remindersScheduledRead.resolve({ topic: 'weather', time: at(7), every: 'day' }, ctx));
    expect(input.rule).toEqual({ freq: 'daily', hour: 7, minute: 0 });
    expect(input.action).toBe('weather');
    expect(input.localWallTime).toBe('2026-09-25T07:00');
    expect(input.text).toBe('מזג האוויר (שליחה קבועה)');
  });

  it('weekly on named days, as reminders.repeat reads them', () => {
    const input = ready(remindersScheduledRead.resolve({ topic: 'jewish_calendar', time: at(12), weekdays: [5] }, ctx));
    expect(input.rule).toEqual({ freq: 'weekly', hour: 12, minute: 0, weekdays: [5] });
    expect(input.localWallTime).toBe('2026-09-25T12:00');
  });

  it('asks what to send when no topic is named', () => {
    expect(remindersScheduledRead.resolve({ time: at(7), every: 'day' }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'missing_slot', slot: 'target' },
    });
  });

  it('never runs a topic off the closed list', () => {
    expect(remindersScheduledRead.resolve({ topic: 'wikipedia', time: at(7), every: 'day' }, ctx).kind).toBe('clarify');
  });

  it('asks for a time rather than defaulting one (R3)', () => {
    expect(remindersScheduledRead.resolve({ topic: 'news', every: 'day' }, ctx)).toMatchObject({
      clarify: { code: 'time', detail: { rule: 'R3' } },
    });
  });

  it('asks how often when nothing says', () => {
    expect(remindersScheduledRead.resolve({ topic: 'news', time: at(8) }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'missing_slot', slot: 'date' },
    });
  });

  it('asks now about a time a coming clock change repeats (R2)', () => {
    expect(
      remindersScheduledRead.resolve({ topic: 'news', time: { ...at(1, 30), part_of_day: 'night' }, every: 'day' }, ctx),
    ).toMatchObject({ clarify: { code: 'time', detail: { rule: 'R2' } } });
  });

  // -- execute, list, cancel, undo --------------------------------------------

  it('stores the action, says what was set, and lists it', async () => {
    const input = ready(remindersScheduledRead.resolve({ topic: 'weather', time: at(7), every: 'day' }, ctx));
    const result = await remindersScheduledRead.execute(input, ctx);
    expect(stripIsolates(result.text)).toContain('נקבעה שליחה קבועה: כל יום · 07:00');
    expect(reminders.listUpcoming(PRINCIPAL)[0]?.action).toBe('weather');

    const listed = await remindersList.execute({}, ctx);
    expect(stripIsolates(listed.text)).toContain('מזג האוויר (שליחה קבועה)');
  });

  it('is found and cancelled by its name, series and all', async () => {
    const input = ready(remindersScheduledRead.resolve({ topic: 'weather', time: at(7), every: 'day' }, ctx));
    await remindersScheduledRead.execute(input, ctx);

    const found = remindersCancel.resolve({ query_variants: ['מזג האוויר'] }, ctx);
    expect(found.kind).toBe('ready');
    if (found.kind !== 'ready') return;
    await remindersCancel.execute(found.input, ctx);
    expect(reminders.listUpcoming(PRINCIPAL)).toEqual([]);
  });

  it('Undo ends the whole series', async () => {
    const input = ready(remindersScheduledRead.resolve({ topic: 'news', time: at(7), every: 'day' }, ctx));
    const result = await remindersScheduledRead.execute(input, ctx);
    await remindersScheduledRead.undo!(result.compensating, ctx);
    expect(reminders.listUpcoming(PRINCIPAL)).toEqual([]);
  });

  // -- the store ----------------------------------------------------------------

  describe('the store', () => {
    const scheduleRead = (action: ScheduledTopic = 'weather') =>
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'מזג האוויר (שליחה קבועה)',
        dueAtUtc: NOW + HOUR,
        localWallTime: '2026-09-24T13:00',
        tz: 'Asia/Jerusalem',
        rule: { freq: 'daily', hour: 13, minute: 0 },
        action,
      });

    it('carries the action into the next occurrence', () => {
      scheduleRead('uv_air');
      now = NOW + HOUR;
      const [claimed] = reminders.claimDue();
      expect(claimed?.action).toBe('uv_air');
      const [next] = reminders.listUpcoming(PRINCIPAL);
      expect(next?.action).toBe('uv_air');
      expect(next?.dueAtUtc).toBe(NOW + 25 * HOUR);
    });

    it('reads an unknown stored action as no action, never as something to run', () => {
      const row = scheduleRead();
      driver.exec(`UPDATE reminders SET action = 'shell' WHERE id = ?`, row.id);
      expect(reminders.byId(row.id)?.action).toBeNull();
    });

    it('stillClaimed is false after a cancel, or after another claim took the row', () => {
      const row = scheduleRead();
      now = NOW + HOUR;
      const [claimed] = reminders.claimDue();
      expect(reminders.stillClaimed(row.id, claimed!.attempts)).toBe(true);

      // The lease runs out mid-read and a second claim takes it.
      now += 61_000;
      reminders.claimDue();
      expect(reminders.stillClaimed(row.id, claimed!.attempts)).toBe(false);

      reminders.cancel(row.id, PRINCIPAL);
      expect(reminders.stillClaimed(row.id, claimed!.attempts + 1)).toBe(false);
    });

    it('markSkipped closes a claimed row without sending', () => {
      const row = scheduleRead();
      now = NOW + HOUR;
      reminders.claimDue();
      reminders.markSkipped(row.id);
      expect(reminders.byId(row.id)?.status).toBe('done');
      expect(reminders.takeFailed()).toEqual([]);
    });

    it('plainOnly leaves scheduled reads out', () => {
      scheduleRead();
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'לקנות חלב',
        dueAtUtc: NOW + 2 * HOUR,
        localWallTime: '2026-09-24T14:00',
        tz: 'Asia/Jerusalem',
      });
      expect(reminders.listUpcoming(PRINCIPAL, 20, { plainOnly: true }).map((r) => r.text)).toEqual(['לקנות חלב']);
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(2);
    });
  });

  // -- the message at the due time ------------------------------------------------

  describe('scheduledReadMessage', () => {
    const claimed = (lateByMs: number, action: ScheduledTopic = 'day_times'): ClaimedReminder & { action: ScheduledTopic } => ({
      id: 'r1',
      principal: PRINCIPAL,
      text: 'זמני היום (שליחה קבועה)',
      dueAtUtc: NOW - lateByMs,
      localWallTime: '',
      tz: 'Asia/Jerusalem',
      status: 'sending',
      attempts: 1,
      backupEventId: null,
      seriesId: 's1',
      rule: { freq: 'daily', hour: 12, minute: 0 },
      action,
      lateByMs,
    });

    const deps = (fetchImpl: typeof fetch) => ({ nowMs: NOW, lang: 'he' as const, repo, log: createFakeLogger(), fetchImpl });

    it('computes the read in code and sends it under its name', async () => {
      // The day's times need no network: no home city means Jerusalem.
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const text = stripIsolates((await scheduledReadMessage(claimed(0), deps(fetchImpl)))!);
      expect(text).toContain('זמני היום (שליחה קבועה)');
      expect(text).toContain('שקיעה');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('drops a read held for longer than two hours', async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      expect(await scheduledReadMessage(claimed(SCHEDULED_READ_MAX_LATE_MS + 1), deps(fetchImpl))).toBeNull();
    });

    it('says the information is unavailable when the source fails', async () => {
      const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
      const text = stripIsolates((await scheduledReadMessage(claimed(0, 'news'), deps(fetchImpl)))!);
      expect(text).toContain('המידע לא זמין כרגע');
    });

    it('stops waiting at the deadline', async () => {
      vi.useFakeTimers();
      const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const pending = scheduledReadMessage(claimed(0, 'news'), deps(fetchImpl));
      await vi.advanceTimersByTimeAsync(SCHEDULED_READ_DEADLINE_MS + 1);
      expect(stripIsolates((await pending)!)).toContain('המידע לא זמין כרגע');
    });
  });
});
