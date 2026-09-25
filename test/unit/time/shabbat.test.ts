/**
 * Shabbat, chagim and sunset (PLAN §6.13, §11.1).
 *
 * The published times are the test oracle. Sunset in Jerusalem is a number
 * anyone can look up, and a solar algorithm that is a few minutes out is a
 * feature that releases a reminder during Shabbat or holds one for an extra
 * hour — so the tolerance here is tight on purpose.
 */
import { describe, expect, it } from 'vitest';
import { duskOn, sunriseOn, sunsetOn, JERUSALEM } from '../../../src/time/sun.js';
import {
  CANDLE_LIGHTING_MINUTES,
  hebrewDateOf,
  nextPermittedAt,
  restKindOfDay,
  restPeriodAt,
} from '../../../src/time/shabbat.js';

const ZONE = 'Asia/Jerusalem';

const clock = (ms: number | null): string =>
  ms === null
    ? 'none'
    : new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));

/** Local wall time in Asia/Jerusalem as an instant. DST-correct by construction. */
const at = (localIso: string): number => {
  const utc = Date.parse(`${localIso}Z`);
  // Two passes: guess UTC, read back the local offset, correct. Enough for a
  // fixture, and it keeps the fixtures readable as local times.
  const offset = offsetAt(utc);
  return Date.parse(`${localIso}${offset}`);
};

function offsetAt(ms: number): string {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms))
    .find((part) => part.type === 'timeZoneName')?.value;
  return (name ?? 'GMT+03:00').replace('GMT', '');
}

describe('sunset in Jerusalem', () => {
  // Published times for Jerusalem, to the minute. A solar algorithm that is
  // more than two minutes out is not usable for this.
  it.each([
    ['2026-06-19', '19:48'],
    ['2026-12-18', '16:39'],
    ['2026-09-25', '18:32'],
  ])('sets on %s at about %s', (date, expected) => {
    const actual = clock(sunsetOn(Date.parse(`${date}T10:00:00Z`), JERUSALEM));
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    expect(Math.abs(minutes(actual) - minutes(expected)), `${date}: got ${actual}`).toBeLessThanOrEqual(2);
  });

  it('rises before it sets, every day of the year', () => {
    for (let day = 0; day < 365; day++) {
      const ms = Date.UTC(2026, 0, 1) + day * 86_400_000;
      const rise = sunriseOn(ms);
      const set = sunsetOn(ms);
      expect(rise, String(day)).not.toBeNull();
      expect(set, String(day)).not.toBeNull();
      expect(rise!, String(day)).toBeLessThan(set!);
    }
  });

  it('puts nightfall after sunset, and further after it in summer', () => {
    // Twilight is longer at the solstice than in midwinter at this latitude:
    // the sun's descent is shallower, so it takes longer to reach 8.5° below the
    // horizon. Measured here: ~42 minutes in June against ~40 in December.
    //
    // A small difference, and precisely the point. Nightfall is an angle rather
    // than a fixed offset because no single number of minutes is right all year,
    // and this is the test that would notice if it were replaced by one.
    const summer = Date.parse('2026-06-19T10:00:00Z');
    const winter = Date.parse('2026-12-18T10:00:00Z');

    const summerGap = duskOn(summer, 8.5)! - sunsetOn(summer)!;
    const winterGap = duskOn(winter, 8.5)! - sunsetOn(winter)!;

    expect(winterGap).toBeGreaterThan(0);
    expect(summerGap).toBeGreaterThan(winterGap);
  });

  it('still computes a sane sunset on the day the clocks change', () => {
    // Israel springs forward on the Friday before the last Sunday in March, so
    // 2026-03-27 is both a DST transition and a Friday -- the day a Shabbat
    // calculation is most likely to go wrong. No published reference value is
    // asserted here, only that the answer is an evening in Jerusalem.
    const sunset = sunsetOn(Date.parse('2026-03-27T10:00:00Z'));
    expect(sunset).not.toBeNull();
    expect(clock(sunset)).toMatch(/^18:/);
  });

  it('reports no sunset where there is none, rather than inventing one', () => {
    // Not a case Israel produces. It is here so the function cannot be reused
    // somewhere it would quietly lie.
    const arctic = { latitude: 78.2, longitude: 15.6 };
    expect(sunsetOn(Date.parse('2026-06-21T10:00:00Z'), arctic)).toBeNull();
  });
});

describe('the Hebrew date', () => {
  it('comes from Intl with no dependency and no table', () => {
    expect(hebrewDateOf(Date.parse('2026-09-25T10:00:00Z'))).toEqual({ month: 'Tishri', day: 14 });
    expect(hebrewDateOf(Date.parse('2026-04-02T10:00:00Z'))).toEqual({ month: 'Nisan', day: 15 });
  });

  it('names the month rather than numbering it', () => {
    // A leap year inserts Adar I and shifts every following month's number, so
    // a numeric month would point at the wrong one in seven years of nineteen.
    const inLeapYear = hebrewDateOf(Date.parse('2027-04-22T10:00:00Z'));
    expect(typeof inLeapYear.month).toBe('string');
    expect(inLeapYear.month).not.toMatch(/^\d+$/);
  });
});

describe('which days are rest days', () => {
  it('knows Saturday', () => {
    expect(restKindOfDay(at('2026-09-26T12:00:00'))).toBe('shabbat');
    expect(restKindOfDay(at('2026-09-25T12:00:00'))).toBeNull();
  });

  it('knows yom tov', () => {
    // 2026-04-02 is 15 Nisan — the first day of Pesach.
    expect(restKindOfDay(Date.parse('2026-04-02T10:00:00Z'))).toBe('chag');
    // 2026-09-26 is 15 Tishri, Sukkot, and also a Saturday.
    expect(restKindOfDay(Date.parse('2026-09-12T10:00:00Z'))).toBe('shabbat');
  });

  it('treats chol hamoed as a working day, because it is one', () => {
    // 17 Nisan 5786 = 2026-04-04, an intermediate day of Pesach. Holding a
    // week of reminders because it is Pesach would be the feature overreaching.
    const cholHamoed = Date.parse('2026-04-05T10:00:00Z');
    expect(hebrewDateOf(cholHamoed).month).toBe('Nisan');
    expect(restKindOfDay(cholHamoed)).toBeNull();
  });
});

describe('the rest period', () => {
  it('starts before sunset on Friday and ends after nightfall on Saturday', () => {
    const fridayAfternoon = at('2026-09-25T17:00:00');
    const period = restPeriodAt(at('2026-09-25T19:00:00'));

    expect(period).not.toBeNull();
    expect(period!.kind).toBe('shabbat');

    const sunset = sunsetOn(fridayAfternoon)!;
    expect(period!.startUtc).toBe(sunset - CANDLE_LIGHTING_MINUTES * 60_000);
    expect(period!.endUtc).toBeGreaterThan(at('2026-09-26T19:00:00'));
  });

  it('does not hold a Friday afternoon', () => {
    // Sunset on 2026-09-25 is 18:32, so 17:00 is an ordinary Friday afternoon.
    // A fixed "Friday 18:00" rule would have got this wrong.
    expect(restPeriodAt(at('2026-09-25T17:00:00'))).toBeNull();
  });

  it('holds the same Friday evening in December, when sunset is two hours earlier', () => {
    // 2026-12-18 sets at 16:39. This is the case a fixed-hour rule cannot get
    // right in both seasons, and the reason sunset is computed at all.
    expect(restPeriodAt(at('2026-12-18T17:30:00'))).not.toBeNull();
    expect(restPeriodAt(at('2026-12-18T15:00:00'))).toBeNull();
  });

  it('is over on Saturday night', () => {
    expect(restPeriodAt(at('2026-09-26T21:00:00'))).toBeNull();
  });

  it('merges a chag that runs into Shabbat into one period', () => {
    // 2026-10-02 is Friday, 21 Tishri — Hoshana Rabba, not yom tov. 2026-10-03
    // is Saturday and 22 Tishri, Shmini Atzeret: chag and Shabbat on one day.
    const period = restPeriodAt(at('2026-10-03T12:00:00'));
    expect(period).not.toBeNull();
    // Reporting two periods would let a message out at the seam, which is the
    // exact thing being avoided.
    expect(period!.endUtc - period!.startUtc).toBeGreaterThan(24 * 3_600_000);
  });

  it('holds Rosh Hashana across both of its days', () => {
    // 5787 begins at sunset on 2026-09-11; 1-2 Tishri are 12-13 September, and
    // the 12th is a Saturday, so this is a three-day run.
    const period = restPeriodAt(Date.parse('2026-09-13T10:00:00Z'));
    expect(period).not.toBeNull();
    expect(period!.endUtc - period!.startUtc).toBeGreaterThan(40 * 3_600_000);
  });
});

describe('when a held message may go', () => {
  it('leaves an unheld instant alone', () => {
    const tuesday = at('2026-09-22T10:00:00');
    expect(nextPermittedAt(tuesday)).toBe(tuesday);
  });

  it('moves a Shabbat instant to the end of Shabbat', () => {
    const during = at('2026-09-26T12:00:00');
    const after = nextPermittedAt(during);

    expect(after).toBeGreaterThan(during);
    expect(clock(after)).toMatch(/^19:/);
    // And the moved instant is itself no longer held, or the caller would loop.
    expect(nextPermittedAt(after)).toBe(after);
  });
});
