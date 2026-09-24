import { describe, expect, it } from 'vitest';
import { ZONE, localPartsOf, offsetMinutesAt, wallTimeToUtc } from '../../../src/time/tz.js';

const utc = (iso: string) => Date.parse(iso);

describe('localPartsOf', () => {
  it('reads Jerusalem wall time during summer time (+03:00)', () => {
    expect(localPartsOf(utc('2026-09-24T18:00:00Z'), ZONE)).toEqual({
      year: 2026,
      month: 9,
      day: 24,
      hour: 21,
      minute: 0,
      weekday: 4, // Thursday
    });
  });

  it('reads Jerusalem wall time during standard time (+02:00)', () => {
    expect(localPartsOf(utc('2026-12-24T18:00:00Z'), ZONE)).toEqual({
      year: 2026,
      month: 12,
      day: 24,
      hour: 20,
      minute: 0,
      weekday: 4,
    });
  });

  it('numbers weekdays with Sunday as 0', () => {
    expect(localPartsOf(utc('2026-09-27T09:00:00Z'), ZONE).weekday).toBe(0); // Sunday
    expect(localPartsOf(utc('2026-09-26T09:00:00Z'), ZONE).weekday).toBe(6); // Saturday
  });
});

describe('offsetMinutesAt', () => {
  it('is +180 under summer time', () => {
    expect(offsetMinutesAt(utc('2026-09-24T18:00:00Z'), ZONE)).toBe(180);
  });

  it('is +120 under standard time', () => {
    expect(offsetMinutesAt(utc('2026-12-24T18:00:00Z'), ZONE)).toBe(120);
  });
});

describe('wallTimeToUtc', () => {
  it('resolves an ordinary summer wall time', () => {
    const res = wallTimeToUtc({ year: 2026, month: 9, day: 25, hour: 8, minute: 0 }, ZONE);
    expect(res).toEqual({ kind: 'ok', utcMs: utc('2026-09-25T05:00:00Z'), offsetMinutes: 180 });
  });

  it('resolves an ordinary winter wall time', () => {
    const res = wallTimeToUtc({ year: 2026, month: 12, day: 25, hour: 8, minute: 0 }, ZONE);
    expect(res).toEqual({ kind: 'ok', utcMs: utc('2026-12-25T06:00:00Z'), offsetMinutes: 120 });
  });

  it('reports the spring-forward gap as nonexistent', () => {
    // 2026-03-27 02:00 -> 03:00, so 02:30 never happens.
    const res = wallTimeToUtc({ year: 2026, month: 3, day: 27, hour: 2, minute: 30 }, ZONE);
    expect(res.kind).toBe('gap');
  });

  it('accepts the instant just before the gap', () => {
    const res = wallTimeToUtc({ year: 2026, month: 3, day: 27, hour: 1, minute: 59 }, ZONE);
    expect(res.kind).toBe('ok');
  });

  it('accepts the instant just after the gap', () => {
    const res = wallTimeToUtc({ year: 2026, month: 3, day: 27, hour: 3, minute: 0 }, ZONE);
    expect(res).toMatchObject({ kind: 'ok', offsetMinutes: 180 });
  });

  it('reports the fall-back fold as ambiguous with both instants', () => {
    // 2026-10-25 02:00 -> 01:00, so 01:30 happens twice.
    const res = wallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, ZONE);
    expect(res.kind).toBe('fold');
    if (res.kind === 'fold') {
      expect(res.utcMsCandidates).toEqual([
        utc('2026-10-24T22:30:00Z'),
        utc('2026-10-24T23:30:00Z'),
      ]);
    }
  });

  it('accepts a time after the fold has ended', () => {
    const res = wallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 14, minute: 0 }, ZONE);
    expect(res).toMatchObject({ kind: 'ok', offsetMinutes: 120 });
  });

  it('round-trips every resolved instant back to the same wall time', () => {
    for (let day = 1; day <= 28; day++) {
      for (const hour of [0, 6, 12, 18, 23]) {
        const wall = { year: 2026, month: 6, day, hour, minute: 15 };
        const res = wallTimeToUtc(wall, ZONE);
        expect(res.kind).toBe('ok');
        if (res.kind !== 'ok') continue;
        const back = localPartsOf(res.utcMs, ZONE);
        expect({ year: back.year, month: back.month, day: back.day, hour: back.hour, minute: back.minute })
          .toEqual(wall);
      }
    }
  });
});
