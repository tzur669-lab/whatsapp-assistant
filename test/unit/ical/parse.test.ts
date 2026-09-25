/**
 * Reading an iCalendar feed (PLAN §6.15, RFC 5545, §11.1).
 *
 * Every fixture here is a file from the internet as far as the parser is
 * concerned, so the cases split in two: does it read a well-formed feed
 * correctly, and does a malformed one cost exactly the event that is broken?
 */
import { describe, expect, it } from 'vitest';
import { parseIcal, MAX_EVENTS } from '../../../src/ical/parse.js';

const ZONE = 'Asia/Jerusalem';

/** A window wide enough that nothing is filtered unless a case means it to be. */
const YEAR = {
  startUtc: Date.parse('2026-01-01T00:00:00Z'),
  endUtc: Date.parse('2027-01-01T00:00:00Z'),
};

const wrap = (body: string): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');

const vevent = (...lines: string[]): string =>
  wrap(['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n'));

const local = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));

describe('a single event', () => {
  it('reads a UTC start and end', () => {
    const { events } = parseIcal(
      vevent('UID:a@test', 'SUMMARY:Standup', 'DTSTART:20260925T060000Z', 'DTEND:20260925T063000Z'),
      YEAR,
      ZONE,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Standup');
    expect(events[0]?.startUtc).toBe(Date.parse('2026-09-25T06:00:00Z'));
    expect(events[0]?.endUtc).toBe(Date.parse('2026-09-25T06:30:00Z'));
    expect(events[0]?.allDay).toBe(false);
  });

  it('reads a wall time in the zone the feed names', () => {
    const { events } = parseIcal(
      vevent(
        'UID:b@test',
        'SUMMARY:Lecture',
        'DTSTART;TZID=Asia/Jerusalem:20260925T090000',
        'DTEND;TZID=Asia/Jerusalem:20260925T110000',
      ),
      YEAR,
      ZONE,
    );
    expect(local(events[0]!.startUtc)).toContain('09:00');
  });

  it('reads a quoted TZID, where the colon is not the separator', () => {
    const { events } = parseIcal(
      vevent('UID:c@test', 'SUMMARY:X', 'DTSTART;TZID="Asia/Jerusalem":20260925T090000'),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(1);
    expect(local(events[0]!.startUtc)).toContain('09:00');
  });

  it('reads a floating time in the assistant\'s own zone', () => {
    // No Z, no TZID. It means the same wall clock wherever it is read, and the
    // only sensible reading here is the zone the assistant lives in.
    const { events } = parseIcal(
      vevent('UID:d@test', 'SUMMARY:X', 'DTSTART:20260925T090000'),
      YEAR,
      ZONE,
    );
    expect(local(events[0]!.startUtc)).toContain('09:00');
  });

  it('reads an all-day event as a whole day', () => {
    const { events } = parseIcal(
      vevent('UID:e@test', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260925'),
      YEAR,
      ZONE,
    );
    expect(events[0]?.allDay).toBe(true);
    expect(events[0]!.endUtc - events[0]!.startUtc).toBe(24 * 3_600_000);
  });

  it('gives a timed event with no end an hour, which is what a client shows', () => {
    const { events } = parseIcal(
      vevent('UID:f@test', 'SUMMARY:X', 'DTSTART:20260925T060000Z'),
      YEAR,
      ZONE,
    );
    expect(events[0]!.endUtc - events[0]!.startUtc).toBe(3_600_000);
  });

  it('reads DURATION when there is no DTEND', () => {
    const { events } = parseIcal(
      vevent('UID:g@test', 'SUMMARY:X', 'DTSTART:20260925T060000Z', 'DURATION:PT1H30M'),
      YEAR,
      ZONE,
    );
    expect(events[0]!.endUtc - events[0]!.startUtc).toBe(90 * 60_000);
  });

  it('unfolds a title split across lines', () => {
    const { events } = parseIcal(
      vevent('UID:h@test', 'SUMMARY:A very long title that the ', ' producer folded', 'DTSTART:20260925T060000Z'),
      YEAR,
      ZONE,
    );
    expect(events[0]?.title).toBe('A very long title that the producer folded');
  });

  it('unescapes a title', () => {
    const { events } = parseIcal(
      vevent('UID:i@test', 'SUMMARY:Review\\, then lunch\\; maybe', 'DTSTART:20260925T060000Z'),
      YEAR,
      ZONE,
    );
    expect(events[0]?.title).toBe('Review, then lunch; maybe');
  });

  it('leaves out a cancelled event, which is still in the file', () => {
    const { events } = parseIcal(
      vevent('UID:j@test', 'SUMMARY:X', 'DTSTART:20260925T060000Z', 'STATUS:CANCELLED'),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(0);
  });

  it('includes an event already under way at the start of the window', () => {
    // Overlap, not containment: a meeting that began an hour ago and is still
    // going is on your calendar right now.
    const { events } = parseIcal(
      vevent('UID:k@test', 'SUMMARY:X', 'DTSTART:20260925T060000Z', 'DTEND:20260925T100000Z'),
      { startUtc: Date.parse('2026-09-25T08:00:00Z'), endUtc: Date.parse('2026-09-25T12:00:00Z') },
      ZONE,
    );
    expect(events).toHaveLength(1);
  });
});

describe('recurrence', () => {
  it('expands a weekly rule into the window', () => {
    const { events } = parseIcal(
      vevent(
        'UID:r1@test',
        'SUMMARY:Standup',
        'DTSTART;TZID=Asia/Jerusalem:20260907T090000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(4);
    expect(events.map((e) => local(e.startUtc).slice(0, 10))).toEqual([
      '07/09/2026',
      '14/09/2026',
      '21/09/2026',
      '28/09/2026',
    ]);
  });

  it('keeps the wall clock across a DST change', () => {
    // Israel falls back on 2026-10-25. "Every Sunday at 09:00" means nine in the
    // morning on both sides of it; adding 7 x 86,400,000 would move it by an hour.
    const { events } = parseIcal(
      vevent(
        'UID:r2@test',
        'SUMMARY:Weekly',
        'DTSTART;TZID=Asia/Jerusalem:20261018T090000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ),
      YEAR,
      ZONE,
    );
    for (const event of events) expect(local(event.startUtc)).toContain('09:00');
  });

  it('stops at UNTIL', () => {
    const { events } = parseIcal(
      vevent(
        'UID:r3@test',
        'SUMMARY:X',
        'DTSTART:20260901T060000Z',
        'RRULE:FREQ=DAILY;UNTIL=20260903T235959Z',
      ),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(3);
  });

  it('honours INTERVAL', () => {
    const { events } = parseIcal(
      vevent('UID:r4@test', 'SUMMARY:X', 'DTSTART:20260901T060000Z', 'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=3'),
      YEAR,
      ZONE,
    );
    const days = events.map((e) => new Date(e.startUtc).getUTCDate());
    expect(days).toEqual([1, 4, 7]);
  });

  it('expands BYDAY within a week', () => {
    // A timetable's "Sunday and Tuesday" is one rule, not two events.
    const { events } = parseIcal(
      vevent(
        'UID:r5@test',
        'SUMMARY:Class',
        'DTSTART;TZID=Asia/Jerusalem:20260906T090000',
        'RRULE:FREQ=WEEKLY;BYDAY=SU,TU;COUNT=4',
      ),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(4);
    expect(events.map((e) => local(e.startUtc).slice(0, 10))).toEqual([
      '06/09/2026',
      '08/09/2026',
      '13/09/2026',
      '15/09/2026',
    ]);
  });

  it('skips a month that has no such day rather than rolling into the next', () => {
    // The 31st of a 30-day month. Rolling would put a monthly meeting on the 1st
    // four times a year without anyone asking for it.
    const { events } = parseIcal(
      vevent('UID:r6@test', 'SUMMARY:X', 'DTSTART:20260131T060000Z', 'RRULE:FREQ=MONTHLY;COUNT=3'),
      YEAR,
      ZONE,
    );
    for (const event of events) expect(new Date(event.startUtc).getUTCDate()).toBe(31);
  });

  it('removes an instance named in EXDATE', () => {
    const { events } = parseIcal(
      vevent(
        'UID:r7@test',
        'SUMMARY:X',
        'DTSTART:20260901T060000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE:20260902T060000Z',
      ),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(2);
  });

  it('clips an endless rule to the window instead of running forever', () => {
    const { events } = parseIcal(
      vevent('UID:r8@test', 'SUMMARY:X', 'DTSTART:20260901T060000Z', 'RRULE:FREQ=DAILY'),
      { startUtc: Date.parse('2026-09-01T00:00:00Z'), endUtc: Date.parse('2026-09-08T00:00:00Z') },
      ZONE,
    );
    expect(events).toHaveLength(7);
  });

  it('ignores a frequency that belongs to machines rather than calendars', () => {
    const { events } = parseIcal(
      vevent('UID:r9@test', 'SUMMARY:X', 'DTSTART:20260901T060000Z', 'RRULE:FREQ=SECONDLY;COUNT=100'),
      YEAR,
      ZONE,
    );
    // The rule is dropped, the event itself is not.
    expect(events).toHaveLength(1);
  });
});

describe('a feed that is not well formed', () => {
  it('drops the broken event and keeps the rest', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:good@test',
        'SUMMARY:Fine',
        'DTSTART:20260925T060000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:bad@test',
        'SUMMARY:No start at all',
        'END:VEVENT',
      ].join('\r\n'),
    );

    const result = parseIcal(feed, YEAR, ZONE);
    expect(result.events).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('ignores a property it does not understand', () => {
    const { events } = parseIcal(
      vevent('UID:x@test', 'SUMMARY:X', 'DTSTART:20260925T060000Z', 'X-WR-SOMETHING:whatever', 'ATTACH:https://example.test/a.pdf'),
      YEAR,
      ZONE,
    );
    expect(events).toHaveLength(1);
  });

  it('survives an empty file, a truncated one and one that is not iCalendar', () => {
    for (const text of ['', 'BEGIN:VCALENDAR', 'not a calendar at all', '{"json": true}']) {
      expect(() => parseIcal(text, YEAR, ZONE)).not.toThrow();
      expect(parseIcal(text, YEAR, ZONE).events).toEqual([]);
    }
  });

  it('caps the number of events, and says that it did', () => {
    const many = Array.from({ length: MAX_EVENTS + 50 }, (_, i) =>
      ['BEGIN:VEVENT', `UID:m${i}@test`, 'SUMMARY:X', 'DTSTART:20260925T060000Z', 'END:VEVENT'].join('\r\n'),
    ).join('\r\n');

    const result = parseIcal(wrap(many), YEAR, ZONE);
    expect(result.events.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(result.truncated).toBe(true);
  });

  it('reads CRLF, LF and a mixture of the two', () => {
    const body = 'BEGIN:VEVENT\nUID:n@test\r\nSUMMARY:Mixed\nDTSTART:20260925T060000Z\r\nEND:VEVENT';
    expect(parseIcal(wrap(body), YEAR, ZONE).events).toHaveLength(1);
  });
});
