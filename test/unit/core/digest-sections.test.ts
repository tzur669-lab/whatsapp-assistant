/**
 * The digest's optional sections (block J, J5): tomorrow's conflicts and bills
 * due this week. Off by default; an empty section is not shown and does not
 * make a quiet day send; a failing one never drops the others.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { buildDigest } from '../../../src/core/digest.js';
import { matchCommand } from '../../../src/core/router.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { GmailClient } from '../../../src/google/gmail.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

/** Tuesday 2026-10-13, 07:00 local. */
const NOW = Date.parse('2026-10-13T04:00:00Z');
const P = 'p_digest_j5';

const event = (id: string, startIso: string, minutes: number, title = id): CalendarEvent => ({
  id,
  title,
  startUtc: Date.parse(startIso),
  endUtc: Date.parse(startIso) + minutes * 60_000,
  allDay: false,
  createdByAssistant: false,
  etag: null,
});

/** Answers each window with the events inside it. */
function calendar(events: CalendarEvent[]): CalendarClient {
  return {
    async listAllEvents(range: { startUtc: number; endUtc: number }) {
      return { ok: true as const, value: events.filter((e) => e.startUtc >= range.startUtc && e.startUtc <= range.endUtc) };
    },
  } as unknown as CalendarClient;
}

function gmail(mails: Array<{ id: string; subject: string; body: string }> | 'down'): GmailClient {
  return {
    async search() {
      if (mails === 'down') return { ok: false as const, error: { code: 'unavailable' as const } };
      return {
        ok: true as const,
        value: mails.map((m) => ({ id: m.id, threadId: m.id, fromName: 'חברת החשמל', subject: m.subject, snippet: '', at: NOW - 86_400_000 })),
      };
    },
    async body(id: string) {
      return { ok: true as const, value: mails === 'down' ? '' : (mails.find((m) => m.id === id)?.body ?? '') };
    },
  } as unknown as GmailClient;
}

describe('digest sections', () => {
  let driver: TestSqlDriver;
  let reminders: ReminderStore;
  let log: ReturnType<typeof createFakeLogger>;

  const base = () => ({ nowMs: NOW, principal: P, lang: 'he' as const, reminders, log });
  const tomorrowClash = [event('a', '2026-10-14T07:00:00Z', 60, 'פגישה עם דני'), event('b', '2026-10-14T07:30:00Z', 60, 'רופא שיניים')];

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('are off by default: a clash tomorrow alone sends nothing', async () => {
    expect(await buildDigest({ ...base(), calendar: calendar(tomorrowClash) })).toBeNull();
  });

  it("shows tomorrow's overlap when on, and sends for it", async () => {
    const text = await buildDigest({ ...base(), calendar: calendar(tomorrowClash), sections: { conflicts: true } });
    const plain = stripIsolates(text ?? '');
    expect(plain).toContain('חפיפות ביומן מחר');
    expect(plain).toContain('10:00–11:00 פגישה עם דני / 10:30–11:30 רופא שיניים');
  });

  it('touching events are not shown, and a quiet day stays quiet', async () => {
    const touching = [event('a', '2026-10-14T07:00:00Z', 60), event('b', '2026-10-14T08:00:00Z', 60)];
    expect(await buildDigest({ ...base(), calendar: calendar(touching), sections: { conflicts: true } })).toBeNull();
  });

  it('lists bills due within a week, not later ones or ones without a date', async () => {
    const mails = [
      { id: 'm1', subject: 'חשבון חשמל', body: 'סה"כ לתשלום 250.50 ₪. לתשלום עד 16/10/2026' },
      { id: 'm2', subject: 'חשבון מים', body: 'לתשלום 80 ₪ לתשלום עד 30/10/2026' },
      { id: 'm3', subject: 'חשבונית', body: 'סכום 40 ₪' },
    ];
    const plain = stripIsolates((await buildDigest({ ...base(), gmail: gmail(mails), sections: { bills: true } })) ?? '');
    expect(plain).toContain('חשבונות לתשלום בשבוע הקרוב');
    expect(plain).toContain('חשבון חשמל');
    expect(plain).toContain('250.5');
    expect(plain).not.toContain('חשבון מים');
    expect(plain).not.toContain('חשבונית');
  });

  it('a Gmail error drops only its section', async () => {
    const text = await buildDigest({
      ...base(),
      calendar: calendar(tomorrowClash),
      gmail: gmail('down'),
      sections: { conflicts: true, bills: true },
    });
    expect(stripIsolates(text ?? '')).toContain('חפיפות ביומן מחר');
    expect(log.captured.some((entry) => entry.event === 'digest_bills_failed')).toBe(true);
  });

  it('the commands turn each section on and off', () => {
    expect(matchCommand('/digest conflicts on')).toEqual({ kind: 'digest', set: { section: 'conflicts', on: true } });
    expect(matchCommand('/digest bills off')).toEqual({ kind: 'digest', set: { section: 'bills', on: false } });
    expect(matchCommand('/digest 7')).toEqual({ kind: 'digest', set: 7 });
    expect(matchCommand('/digest weather on')).toBeNull();
  });

  it('the setting is stored and read back', () => {
    const repo = new Repository(driver);
    expect(repo.digestSection('bills')).toBe(false);
    repo.setDigestSection('bills', true);
    expect(repo.digestSection('bills')).toBe(true);
    repo.setDigestSection('bills', false);
    expect(repo.digestSection('bills')).toBe(false);
  });
});
