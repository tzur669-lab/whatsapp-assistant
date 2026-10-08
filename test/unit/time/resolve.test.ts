/**
 * PLAN §11.1. Every case freezes "now" explicitly — nothing here reads the
 * real clock.
 */
import { describe, expect, it } from 'vitest';
import { resolveDay, resolveWhen, DEFAULT_TIME_SETTINGS } from '../../../src/time/resolve.js';
import type { DateSpec, TimeSpec } from '../../../src/time/resolve.js';

const at = (iso: string) => Date.parse(iso);

/** Thursday 24.9.2026 21:00 Jerusalem (+03:00). */
const THU_2100 = at('2026-09-24T18:00:00Z');

const time = (hour: number, minute = 0, extra: Partial<TimeSpec> = {}): TimeSpec => ({
  hour,
  minute,
  meridiem: 'unspecified',
  part_of_day: 'unspecified',
  ...extra,
});

const run = (
  nowMs: number,
  date: DateSpec | undefined,
  timeSpec: TimeSpec | undefined,
  settings = DEFAULT_TIME_SETTINGS,
) => resolveWhen({ date, time: timeSpec }, { nowMs, settings });

describe('R1 — in_duration', () => {
  it('adds minutes to now', () => {
    const res = run(at('2026-09-24T20:30:00Z'), { kind: 'in_duration', minutes: 120 }, undefined);
    expect(res).toMatchObject({ kind: 'resolved', utcMs: at('2026-09-24T22:30:00Z') });
  });

  it('crosses midnight correctly', () => {
    // Thu 23:30 local -> Fri 01:30 local.
    const res = run(at('2026-09-24T20:30:00Z'), { kind: 'in_duration', minutes: 120 }, undefined);
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local).toMatchObject({ day: 25, hour: 1, minute: 30 });
  });

  it('is exempt from the unlikely-hour guard (R5)', () => {
    // Lands at 03:30 local, but the user said "in two hours" outright.
    const res = run(at('2026-09-24T22:30:00Z'), { kind: 'in_duration', minutes: 120 }, undefined);
    expect(res.kind).toBe('resolved');
  });

  it('rejects a non-positive or absurd duration', () => {
    expect(run(THU_2100, { kind: 'in_duration', minutes: 0 }, undefined).kind).toBe('clarify');
    expect(run(THU_2100, { kind: 'in_duration', minutes: -5 }, undefined).kind).toBe('clarify');
  });
});

describe('R2 — DST edges', () => {
  // Both Israeli transitions happen inside the R5 window, so these cases state
  // the night explicitly to get past R5 and exercise R2 itself.
  const night = (hour: number, minute: number) => time(hour, minute, { part_of_day: 'night' });

  it('clarifies a spring-forward gap', () => {
    const res = run(at('2026-03-26T12:00:00Z'), { kind: 'absolute', day: 27, month: 3 }, night(2, 30));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R2', reason: 'nonexistent_local_time' });
  });

  it('clarifies a fall-back fold and offers both instants', () => {
    const res = run(at('2026-10-24T12:00:00Z'), { kind: 'absolute', day: 25, month: 10 }, night(1, 30));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R2', reason: 'ambiguous_local_time' });
    if (res.kind !== 'clarify') throw new Error('expected clarify');
    expect(res.options?.map((o) => o.utcMs)).toEqual([
      at('2026-10-24T22:30:00Z'),
      at('2026-10-24T23:30:00Z'),
    ]);
  });

  it('lets R5 answer first for a bare small-hours number at a transition', () => {
    // Asking questions in the cheapest order: an unmarked "2:30" is far more
    // likely a misread hour than a deliberate DST-boundary alarm.
    const res = run(at('2026-03-26T12:00:00Z'), { kind: 'absolute', day: 27, month: 3 }, time(2, 30));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R5' });
  });

  it('resolves 14:00 after DST ends at the standard offset', () => {
    const res = run(at('2026-10-24T12:00:00Z'), { kind: 'absolute', day: 25, month: 10 }, time(14));
    expect(res).toMatchObject({ kind: 'resolved', offsetMinutes: 120 });
  });
});

describe('R3 — missing time is never defaulted', () => {
  it('clarifies when a date is given with no time', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, undefined);
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R3' });
  });

  it('clarifies when nothing at all is given', () => {
    expect(run(THU_2100, undefined, undefined)).toMatchObject({ kind: 'clarify', rule: 'R3' });
  });
});

describe('R4 — 24-hour clock with meridiem and part-of-day adjustment', () => {
  it('reads a bare numeric time as 24-hour', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(14));
    expect(res).toMatchObject({ kind: 'resolved', utcMs: at('2026-09-25T11:00:00Z') });
  });

  it('maps 8 + evening to 20:00', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(8, 0, { part_of_day: 'evening' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(20);
  });

  it('maps 8 + pm to 20:00', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(8, 0, { meridiem: 'pm' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(20);
  });

  it('leaves 8 + morning at 08:00', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(8, 0, { part_of_day: 'morning' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(8);
  });

  it('maps 12 + am to midnight and 12 + pm to noon', () => {
    const midnight = run(THU_2100, { kind: 'relative_days', offset: 2 }, time(12, 0, { meridiem: 'am' }));
    const noon = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(12, 0, { meridiem: 'pm' }));
    if (midnight.kind !== 'resolved' || noon.kind !== 'resolved') throw new Error('expected resolved');
    expect(midnight.local.hour).toBe(0);
    expect(noon.local.hour).toBe(12);
  });

  it('does not push an already-24-hour time past midnight', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(20, 0, { part_of_day: 'evening' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(20);
  });

  it('keeps the small hours as night rather than pushing them to the afternoon', () => {
    // "2 בלילה" is 02:00. Reading it as 14:00 would be a silent, serious error.
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(2, 0, { part_of_day: 'night' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(2);
  });

  it('maps a late evening hour stated as night to the 24-hour clock', () => {
    // "11 בלילה" is 23:00.
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(11, 0, { part_of_day: 'night' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(23);
  });

  it('maps 12 at night to midnight', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(12, 0, { part_of_day: 'night' }));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local.hour).toBe(0);
  });

  it('rejects an out-of-range hour or minute', () => {
    expect(run(THU_2100, { kind: 'relative_days', offset: 1 }, time(25)).kind).toBe('clarify');
    expect(run(THU_2100, { kind: 'relative_days', offset: 1 }, time(10, 61)).kind).toBe('clarify');
  });
});

describe('R5 — unlikely-hour guard, 00:00-05:59', () => {
  it('clarifies 03:00 with no marker', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(3));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R5' });
  });

  it('accepts 03:00 when the night is stated explicitly', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(3, 0, { part_of_day: 'night' }));
    expect(res.kind).toBe('resolved');
  });

  it('accepts 06:00 — the window ends at 05:59', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(6));
    expect(res.kind).toBe('resolved');
  });

  it('clarifies 05:59 and accepts 06:00 exactly at the boundary', () => {
    expect(run(THU_2100, { kind: 'relative_days', offset: 1 }, time(5, 59)).kind).toBe('clarify');
    expect(run(THU_2100, { kind: 'relative_days', offset: 1 }, time(6, 0)).kind).toBe('resolved');
  });

  it('can be switched off through settings', () => {
    const res = run(THU_2100, { kind: 'relative_days', offset: 1 }, time(3), {
      ...DEFAULT_TIME_SETTINGS,
      unlikelyHourGuard: false,
    });
    expect(res.kind).toBe('resolved');
  });
});

describe('R6 — relative date said in the small hours', () => {
  it('clarifies "tomorrow" said at 00:30', () => {
    // Fri 25.9 00:30 local.
    const res = run(at('2026-09-24T21:30:00Z'), { kind: 'relative_days', offset: 1 }, time(9));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R6' });
  });

  it('does not fire at 04:00, past the window', () => {
    const res = run(at('2026-09-25T01:00:00Z'), { kind: 'relative_days', offset: 1 }, time(9));
    expect(res.kind).toBe('resolved');
  });

  it('does not fire for "today"', () => {
    const res = run(at('2026-09-24T21:30:00Z'), { kind: 'relative_days', offset: 0 }, time(9));
    expect(res.kind).toBe('resolved');
  });

  it('does not fire for an absolute date', () => {
    const res = run(at('2026-09-24T21:30:00Z'), { kind: 'absolute', day: 30, month: 9 }, time(9));
    expect(res.kind).toBe('resolved');
  });
});

describe('R7 — resolved instant already in the past', () => {
  it('clarifies "today 08:00" asked at 09:00', () => {
    const res = run(at('2026-09-24T06:00:00Z'), { kind: 'relative_days', offset: 0 }, time(8));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R7' });
  });

  it('offers the same time tomorrow', () => {
    const res = run(at('2026-09-24T06:00:00Z'), { kind: 'relative_days', offset: 0 }, time(8));
    if (res.kind !== 'clarify') throw new Error('expected clarify');
    expect(res.suggestion).toMatchObject({ utcMs: at('2026-09-25T05:00:00Z') });
  });

  it('tolerates a 60 second grace window', () => {
    // 21:00:30 local, asking for 21:00 — 30 s in the past, still accepted.
    const res = run(at('2026-09-24T18:00:30Z'), { kind: 'relative_days', offset: 0 }, time(21));
    expect(res.kind).toBe('resolved');
  });
});

describe('R8 — far horizon', () => {
  it('flags a date more than 365 days ahead for confirmation', () => {
    const res = run(THU_2100, { kind: 'absolute', day: 1, month: 12, year: 2028 }, time(10));
    expect(res).toMatchObject({ kind: 'resolved', needsConfirm: true, rule: 'R8' });
  });

  it('does not flag a date inside the horizon', () => {
    const res = run(THU_2100, { kind: 'absolute', day: 1, month: 12, year: 2026 }, time(10));
    expect(res).toMatchObject({ kind: 'resolved', needsConfirm: false });
  });
});

describe('R9 — weekdays', () => {
  it('clarifies when the weekday equals today', () => {
    // Thursday, asking for Thursday.
    const res = run(THU_2100, { kind: 'weekday', weekday: 4, qualifier: 'unspecified' }, time(10));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R9' });
  });

  it('picks the nearest future occurrence', () => {
    // Thursday 24.9 -> Sunday is 27.9.
    const res = run(THU_2100, { kind: 'weekday', weekday: 0, qualifier: 'unspecified' }, time(10));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local).toMatchObject({ day: 27, month: 9 });
  });

  it('treats "next" the same as the nearest occurrence by default', () => {
    const nearest = run(THU_2100, { kind: 'weekday', weekday: 0, qualifier: 'unspecified' }, time(10));
    const next = run(THU_2100, { kind: 'weekday', weekday: 0, qualifier: 'next' }, time(10));
    expect(next).toEqual(nearest);
  });

  it('can be configured so "next" means the following week', () => {
    const res = run(THU_2100, { kind: 'weekday', weekday: 0, qualifier: 'next' }, time(10), {
      ...DEFAULT_TIME_SETTINGS,
      nextWeekdayMeansFollowingWeek: true,
    });
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local).toMatchObject({ day: 4, month: 10 });
  });

  it('rejects a weekday outside 0-6', () => {
    const res = run(THU_2100, { kind: 'weekday', weekday: 9 as 0, qualifier: 'this' }, time(10));
    expect(res.kind).toBe('clarify');
  });
});

describe('R10 — absolute dates', () => {
  it('uses the nearest future occurrence when no year is given', () => {
    // 24.9.2026 asking for 3.1 -> 3.1.2027.
    const res = run(THU_2100, { kind: 'absolute', day: 3, month: 1 }, time(10));
    if (res.kind !== 'resolved') throw new Error('expected resolved');
    expect(res.local).toMatchObject({ year: 2027, month: 1, day: 3 });
  });

  it('clarifies when the nearest occurrence is more than 300 days away', () => {
    // 29.2 next falls in 2028, well past 300 days.
    const res = run(THU_2100, { kind: 'absolute', day: 29, month: 2 }, time(10));
    expect(res).toMatchObject({ kind: 'clarify', rule: 'R10' });
  });

  it('honours an explicit year even when far away', () => {
    const res = run(THU_2100, { kind: 'absolute', day: 29, month: 2, year: 2028 }, time(10));
    expect(res).toMatchObject({ kind: 'resolved', needsConfirm: true });
  });

  it('rejects a date that does not exist', () => {
    expect(run(THU_2100, { kind: 'absolute', day: 31, month: 9 }, time(10)).kind).toBe('clarify');
    expect(run(THU_2100, { kind: 'absolute', day: 29, month: 2, year: 2027 }, time(10)).kind).toBe('clarify');
  });
});

describe('property: every resolved value is in the future and round-trips', () => {
  it('holds across a year of dates and hours', () => {
    for (let offset = 0; offset < 365; offset += 7) {
      for (const hour of [7, 12, 18, 22]) {
        const res = run(THU_2100, { kind: 'relative_days', offset }, time(hour));
        if (res.kind === 'clarify') continue;
        expect(res.utcMs).toBeGreaterThan(THU_2100 - 60_000);
        expect(res.local.hour).toBe(hour);
        expect(Number.isInteger(res.offsetMinutes)).toBe(true);
      }
    }
  });

  it('never resolves without an explicit time', () => {
    for (let offset = 0; offset < 30; offset++) {
      const res = run(THU_2100, { kind: 'relative_days', offset }, undefined);
      expect(res.kind).toBe('clarify');
    }
  });
});

// 2026-10-08: a read about "today" after noon asked "למתי לקבוע?".
describe('resolveDay: a day, for reads and due dates', () => {
  const today: DateSpec = { kind: 'relative_days', offset: 0 };

  it('is today all day, also after noon', () => {
    for (const iso of ['2026-10-08T08:00:00+03:00', '2026-10-08T13:01:00+03:00', '2026-10-08T23:58:00+03:00']) {
      const day = resolveDay(today, { nowMs: at(iso) });
      expect(day).toMatchObject({ kind: 'resolved', local: { year: 2026, month: 10, day: 8 } });
    }
  });

  it('is noon on a later day', () => {
    const day = resolveDay({ kind: 'relative_days', offset: 2 }, { nowMs: at('2026-10-08T13:01:00+03:00') });
    expect(day).toMatchObject({ kind: 'resolved', local: { day: 10, hour: 12, minute: 0 } });
  });

  it('still asks about a weekday that is today', () => {
    // Thursday 8.10.2026; weekday 4 is Thursday.
    const day = resolveDay({ kind: 'weekday', weekday: 4, qualifier: 'unspecified' }, { nowMs: at('2026-10-08T13:01:00+03:00') });
    expect(day).toMatchObject({ kind: 'clarify', reason: 'weekday_is_today' });
  });
});
