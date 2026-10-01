/**
 * The settings commands, end to end (PLAN §6.12, §6.13, §6.15, §6.16, §11.3).
 *
 * The units behind these are covered elsewhere. What these cover is the gap
 * between "the store works" and "the command works" — routing, the reply the
 * user actually sees, and the rule that none of it goes near the parser.
 *
 * Every one of them is a setting, and nothing received over chat may change
 * policy (invariant 8). An hour, a toggle and a feed URL are close enough to
 * policy to be worth keeping on the deterministic side of that line, and these
 * cases are what says so.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { IcalStore } from '../../../src/ical/store.js';
import { BirthdayStore } from '../../../src/core/birthdays.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.parse('2026-03-14T10:00:00Z');
const PRINCIPAL = 'p_settings0000';

const FEED = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:x@test',
  'SUMMARY:Lecture',
  'DTSTART:20260314T120000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('the settings commands', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let ical: IcalStore;
  let birthdays: BirthdayStore;
  let nlu: ReturnType<typeof createFakeNlu>;
  let log: ReturnType<typeof createFakeLogger>;
  let served: Response;

  const plain = (text: string) => stripIsolates(text);

  const deps = (): PipelineDeps => {
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [nlu],
      ical,
      birthdays,
      fetchImpl: (async () => served.clone()) as unknown as typeof fetch,
    };
    return { repo, log, now: () => NOW, principal: PRINCIPAL, services };
  };

  let counter = 0;
  const say = (text: string): InboundEvent => ({
    kind: 'text',
    wamid: `wamid.s${counter++}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text,
    forwarded: false,
  });

  const reply = async (text: string): Promise<string> => {
    const out = await handleInbound(say(text), deps());
    if (out.action !== 'reply') throw new Error(`expected a reply to ${text}`);
    return plain(out.text);
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    ical = new IcalStore(driver, () => NOW);
    birthdays = new BirthdayStore(driver, () => NOW);
    nlu = createFakeNlu([draft('unsupported', {})]);
    log = createFakeLogger();
    served = new Response(FEED, { status: 200, headers: { etag: '"v1"' } });
    counter = 0;
  });
  afterEach(() => driver.close());

  it('never reaches the parser, for any of them', async () => {
    for (const text of ['/digest 7', '/shabbat on', '/ical https://c.example.test/f.ics', '/birthday דנה 14.3']) {
      await reply(text);
    }
    expect(nlu.inputs).toHaveLength(0);
  });

  describe('/digest', () => {
    it('is off until it is turned on, and says the hour when it is', async () => {
      expect(await reply('/digest')).toContain('כבוי');

      expect(await reply('/digest 7')).toContain('07:00');
      expect(repo.digestHour()).toBe(7);

      expect(await reply('/digest')).toContain('07:00');
    });

    it('says a quiet day sends nothing, because "on" is ambiguous about that', async () => {
      expect(await reply('/digest 7')).toContain('לא תישלח הודעה');
    });

    it('turns off again', async () => {
      await reply('/digest 7');
      expect(await reply('/digest off')).toContain('כבוי');
      expect(repo.digestHour()).toBeNull();
    });
  });

  describe('/shabbat', () => {
    it('is off by default and says what turning it on does', async () => {
      expect(repo.restHoldEnabled()).toBe(false);

      const on = await reply('/shabbat on');
      expect(repo.restHoldEnabled()).toBe(true);
      // It holds everything, with no urgency exception, and says so rather than
      // leaving the user to discover it.
      expect(on).toContain('כל התזכורות');
    });

    it('turns off again', async () => {
      await reply('/shabbat on');
      await reply('/shabbat off');
      expect(repo.restHoldEnabled()).toBe(false);
    });
  });

  describe('/ical', () => {
    it('subscribes, fetches straight away, and reports what it found', async () => {
      // Waiting for the nightly refresh would mean "I will tell you tomorrow",
      // and a link that is wrong is wrong now.
      const text = await reply('/ical https://calendar.example.test/f.ics');

      expect(text).toContain('1');
      expect(ical.feedFor(PRINCIPAL)?.eventCount).toBe(1);
    });

    it('rewrites a webcal: link, which is what a calendar app hands out', async () => {
      await reply('/ical webcal://calendar.example.test/f.ics');
      expect(ical.feedFor(PRINCIPAL)?.url.startsWith('https://')).toBe(true);
    });

    it('says which rule a bad link broke, because it was probably mistyped', async () => {
      expect(await reply('/ical http://calendar.example.test/f.ics')).toContain('https://');
      expect(await reply('/ical https://127.0.0.1/f.ics')).toContain('פנימית');
      expect(ical.feedFor(PRINCIPAL)).toBeNull();
    });

    it('keeps the subscription when the first fetch fails, and reports the error', async () => {
      // The link may be right and the server briefly down; the daily refresh
      // will try again.
      served = new Response('down', { status: 503 });
      const text = await reply('/ical https://calendar.example.test/f.ics');

      expect(text).toContain('E_ICAL_HTTP_503');
      expect(ical.feedFor(PRINCIPAL)).not.toBeNull();
      expect(await reply('/ical')).toContain('E_ICAL_HTTP_503');
    });

    it('unsubscribes', async () => {
      await reply('/ical https://calendar.example.test/f.ics');
      expect(await reply('/ical off')).toContain('נותק');
      expect(ical.feedFor(PRINCIPAL)).toBeNull();
    });

    it('logs no part of the URL, which carries the feed\'s token', async () => {
      await reply('/ical https://calendar.example.test/f.ics?token=s3cr3t');
      const serialized = JSON.stringify(log.captured);
      expect(serialized).not.toContain('s3cr3t');
      expect(serialized).not.toContain('calendar.example.test');
    });
  });

  describe('/city (2026-10-01)', () => {
    const found = () => new Response(JSON.stringify({ results: [{ name: 'חיפה', latitude: 32.79, longitude: 34.99 }] }), { status: 200 });

    it('is Jerusalem until set', async () => {
      expect(await reply('/city')).toBe('העיר לתחזית ולזמני שבת: ירושלים. לשינוי: /city ואחריו שם העיר.');
    });

    it('sets the home city by the name the geocoder knows, and says so', async () => {
      served = found();
      expect(await reply('/city  חיפה ')).toBe('העיר לתחזית ולזמני שבת: חיפה.');
      expect(repo.getSetting('home_city')).toBe('חיפה');
      expect(await reply('/עיר')).toContain('חיפה');
    });

    it('keeps the old city when the new one is not found', async () => {
      served = new Response(JSON.stringify({ results: [] }), { status: 200 });
      expect(await reply('/city אין כזה')).toBe('לא מצאתי עיר בשם אין כזה. העיר נשארה ירושלים.');
      expect(repo.getSetting('home_city')).toBeNull();
    });

    it('never reaches the parser', async () => {
      served = found();
      await reply('/city חיפה');
      expect(nlu.inputs).toHaveLength(0);
    });
  });

  describe('/status', () => {
    it('stays quiet about features that are not in use', async () => {
      // A status report that lists every feature whether or not it is on stops
      // being read, and then so does the line that matters.
      const text = await reply('/status');
      expect(text).not.toContain('תקציר יומי');
      expect(text).not.toContain('יומן חיצוני');
      expect(text).not.toContain('שבת');
    });

    it('reports each one once it is', async () => {
      await reply('/digest 7');
      await reply('/shabbat on');
      await reply('/ical https://calendar.example.test/f.ics');

      const text = await reply('/status');
      expect(text).toContain('07:00');
      expect(text).toContain('שבת');
      expect(text).toContain('יומן חיצוני');
    });

    it('surfaces a feed whose refresh is failing', async () => {
      served = new Response('down', { status: 503 });
      await reply('/ical https://calendar.example.test/f.ics');
      expect(await reply('/status')).toContain('E_ICAL_HTTP_503');
    });
  });

  describe('/birthday', () => {
    it('adds, lists and removes', async () => {
      expect(await reply('/birthday')).toContain('אין ימי הולדת');

      expect(await reply('/birthday דנה 14.3')).toContain('14.3');
      expect(await reply('/birthday')).toContain('דנה');

      expect(await reply('/birthday מחק דנה')).toContain('הוסר');
      expect(await reply('/birthday')).toContain('אין ימי הולדת');
    });

    it('refuses a date that exists in no year', async () => {
      expect(await reply('/birthday דנה 30.2')).toContain('לא קיים');
      expect(birthdays.list(PRINCIPAL)).toHaveLength(0);
    });

    it('answers a name with no date by showing the shape', async () => {
      expect(await reply('/birthday דנה')).toContain('/birthday');
    });

    it('logs no name', async () => {
      await reply('/birthday דנה 14.3');
      expect(JSON.stringify(log.captured)).not.toContain('דנה');
    });
  });
});
