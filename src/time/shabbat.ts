/**
 * Shabbat and chagim (PLAN §6.13).
 *
 * A reminder that buzzes at 19:00 on a Friday in December is the thing that
 * makes a tool feel like it was built somewhere else. This works out when
 * Shabbat and yom tov fall, so a reminder due inside one can be held and
 * delivered afterwards.
 *
 * **Off by default.** Observance is not something software should assume, and a
 * held reminder is a reminder that arrived late — which is the wrong trade for
 * anyone who did not ask for it.
 *
 * **No dependency and no data file.** The Hebrew date comes from `Intl` with the
 * `hebrew` calendar, which every modern runtime ships, and sunset is computed in
 * `src/time/sun.ts`. A Hebrew-calendar package would be a dependency that has to
 * be kept current forever for a table that is already in the platform.
 *
 * **Not a halachic authority.** It computes astronomical times and applies two
 * widely-used offsets, named below. Anyone whose practice differs should leave
 * the setting off; the code makes no claim to settle anything.
 */
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from './tz.js';
import { duskOn, sunsetOn } from './sun.js';
import type { Place } from './sun.js';

/**
 * Candle-lighting: 18 minutes before sunset, the common Israeli practice
 * outside Jerusalem (which keeps 40). Erring early is the safe direction for a
 * feature that holds messages back, so the earlier of the two is not used.
 */
export const CANDLE_LIGHTING_MINUTES = 18;

/**
 * Nightfall at 8.5° of solar depression, the reckoning in general use in Israel.
 *
 * A depression angle rather than "sunset plus N minutes" on purpose: the sun's
 * descent is shallower near the summer solstice, so reaching 8.5° takes about 42
 * minutes in June against about 40 in December. A fixed number of minutes is
 * therefore wrong for most of the year in one direction or the other.
 */
export const NIGHTFALL_DEPRESSION_DEGREES = 8.5;

/** The most consecutive rest days that can occur: yom tov, yom tov, Shabbat. */
const MAX_CONSECUTIVE_REST_DAYS = 3;

export type RestKind = 'shabbat' | 'chag';

export type RestPeriod = {
  startUtc: number;
  endUtc: number;
  /** What it is. A run spanning both reports `chag`, which is the earlier cause. */
  kind: RestKind;
};

/**
 * Yom tov in Israel, as (Hebrew month, day).
 *
 * One day of yom tov, not two: this is for Israel, and the diaspora's second day
 * would hold reminders for a day nobody here is resting.
 *
 * Chol hamoed is deliberately absent. The intermediate days of Sukkot and Pesach
 * are working days for most people, and holding a week of reminders because it
 * is Sukkot would be the feature overreaching.
 */
const YOM_TOV: ReadonlyArray<readonly [string, number]> = [
  ['Tishri', 1], // ראש השנה
  ['Tishri', 2],
  ['Tishri', 10], // יום כיפור
  ['Tishri', 15], // סוכות
  ['Tishri', 22], // שמיני עצרת / שמחת תורה
  ['Nisan', 15], // פסח
  ['Nisan', 21], // שביעי של פסח
  ['Sivan', 6], // שבועות
];

const hebrewParts = new Intl.DateTimeFormat('en-u-ca-hebrew', {
  timeZone: ZONE,
  month: 'long',
  day: 'numeric',
});

/**
 * Month name rather than number.
 *
 * A Hebrew leap year inserts Adar I, which shifts every following month's
 * number — so `month: 'numeric'` would silently point at the wrong month in
 * seven years out of nineteen. The names are stable.
 */
export function hebrewDateOf(atMs: number): { month: string; day: number } {
  const parts = hebrewParts.formatToParts(new Date(atMs));
  return {
    month: parts.find((part) => part.type === 'month')?.value ?? '',
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 0),
  };
}

/** Is this civil day a rest day? Takes any instant inside it. */
export function restKindOfDay(atMs: number, zone: string = ZONE): RestKind | null {
  // Saturday. The local weekday, so a Friday-evening instant is not mistaken
  // for Shabbat by a UTC reading of the date.
  if (localPartsOf(atMs, zone).weekday === 6) return 'shabbat';
  return isYomTov(atMs) ? 'chag' : null;
}

/** Is this civil day a yom tov, whatever the weekday? Takes any instant inside it. */
export function isYomTov(atMs: number): boolean {
  const { month, day } = hebrewDateOf(atMs);
  return YOM_TOV.some(([name, date]) => name === month && date === day);
}

/** How far ahead to look: a chag can be seven months away (Sukkot to Pesach). */
const MAX_DAYS_AHEAD: Record<'shabbat' | 'chag', number> = { shabbat: 14, chag: 400 };

/**
 * The coming Shabbatot, or the coming chagim, as candle lighting to nightfall,
 * in order, from today on (2026-10-05, "an hour before Shabbat").
 *
 * Per day, not per merged run as `restPeriodAt` is: "before Shabbat" means
 * Friday evening even when a chag began on Thursday, and "after Shabbat"
 * means Saturday night even when a chag follows. A chag of two days in a row
 * (Rosh Hashana) is one, from its eve to its last nightfall. The caller skips
 * whatever has already passed.
 */
export function* upcomingRestTimes(
  fromMs: number,
  which: 'shabbat' | 'chag',
  zone: string = ZONE,
  place?: Place,
): Generator<{ startUtc: number; endUtc: number }> {
  const isDay = (noon: number) =>
    which === 'shabbat' ? localPartsOf(noon, zone).weekday === 6 : isYomTov(noon);

  for (let offset = 0; offset <= MAX_DAYS_AHEAD[which]; offset++) {
    const noon = localNoon(fromMs, offset, zone);
    if (!isDay(noon) || (offset > 0 && isDay(localNoon(noon, -1, zone)))) continue;

    let last = noon;
    while (isDay(localNoon(last, 1, zone))) last = localNoon(last, 1, zone);

    const sunset = sunsetOn(localNoon(noon, -1, zone), place);
    const nightfall = duskOn(last, NIGHTFALL_DEPRESSION_DEGREES, place);
    if (sunset === null || nightfall === null) continue;

    yield { startUtc: sunset - CANDLE_LIGHTING_MINUTES * 60_000, endUtc: nightfall };
  }
}

/**
 * The rest period containing this instant, or null.
 *
 * Three civil days are considered, because a rest period does not line up with
 * one: Friday 19:00 belongs to Saturday's period, and Saturday 23:00 is after
 * nightfall and belongs to none.
 */
export function restPeriodAt(
  atMs: number,
  zone: string = ZONE,
  place?: Place,
): RestPeriod | null {
  for (const offset of [-1, 0, 1]) {
    const period = runContaining(localNoon(atMs, offset, zone), zone, place);
    if (period && atMs >= period.startUtc && atMs < period.endUtc) return period;
  }
  return null;
}

/**
 * When a message held by this instant may be sent.
 *
 * Returns `atMs` unchanged when nothing is holding it, so the caller can use the
 * result unconditionally.
 */
export function nextPermittedAt(atMs: number, zone: string = ZONE, place?: Place): number {
  const period = restPeriodAt(atMs, zone, place);
  return period ? period.endUtc : atMs;
}

/**
 * The maximal run of consecutive rest days around this day, as one period.
 *
 * Merging matters: a chag on Friday runs straight into Shabbat with no break
 * between them, and reporting two periods would let a reminder be delivered at
 * the seam — Friday night — which is the exact thing being avoided.
 */
function runContaining(noonMs: number, zone: string, place?: Place): RestPeriod | null {
  const kind = restKindOfDay(noonMs, zone);
  if (!kind) return null;

  let firstNoon = noonMs;
  let firstKind = kind;
  for (let step = 0; step < MAX_CONSECUTIVE_REST_DAYS; step++) {
    const previous = localNoon(firstNoon, -1, zone);
    const previousKind = restKindOfDay(previous, zone);
    if (!previousKind) break;
    firstNoon = previous;
    firstKind = previousKind;
  }

  let lastNoon = noonMs;
  for (let step = 0; step < MAX_CONSECUTIVE_REST_DAYS; step++) {
    const next = localNoon(lastNoon, 1, zone);
    if (!restKindOfDay(next, zone)) break;
    lastNoon = next;
  }

  const eveBefore = localNoon(firstNoon, -1, zone);
  const sunset = sunsetOn(eveBefore, place);
  const nightfall = duskOn(lastNoon, NIGHTFALL_DEPRESSION_DEGREES, place);

  // Israel is nowhere near a latitude where the sun fails to set, so a null here
  // means something is wrong upstream. Reporting no rest period is the failure
  // that delivers a message rather than the one that silently swallows it.
  if (sunset === null || nightfall === null) return null;

  return {
    startUtc: sunset - CANDLE_LIGHTING_MINUTES * 60_000,
    endUtc: nightfall,
    kind: firstKind,
  };
}

/** Local noon, `offsetDays` away. Noon is never near a boundary or a DST gap. */
function localNoon(atMs: number, offsetDays: number, zone: string): number {
  const local = localPartsOf(atMs, zone);
  const day = addDays({ ...local, hour: 12, minute: 0 }, offsetDays);
  const resolved = wallTimeToUtc({ ...day, hour: 12, minute: 0 }, zone);

  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
  return Date.UTC(day.year, day.month - 1, day.day, 12);
}
