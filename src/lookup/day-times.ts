/**
 * The day's times (2026-10-05, ROADMAP #13): dawn, sunrise, midday, sunset and
 * nightfall at a place, computed here from the sun's position (`src/time/sun.ts`)
 * — no network, no text anyone else wrote, so this does not taint the turn.
 *
 * Astronomical times, not a halachic ruling: dawn at 16.1°, nightfall at 8.5°,
 * midday halfway between sunrise and sunset. The reply says so.
 */
import { formatDay } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { isolateLtr } from '../render/bidi.js';
import { dawnOn, duskOn, sunriseOn, sunsetOn } from '../time/sun.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { LocalParts } from '../time/tz.js';
import type { Place } from './place.js';

const DAWN_DEGREES = 16.1;
const NIGHTFALL_DEGREES = 8.5;

const pad = (n: number) => String(n).padStart(2, '0');

function clock(utcMs: number | null): string | null {
  if (utcMs === null) return null;
  const local = localPartsOf(utcMs, ZONE);
  return isolateLtr(`${pad(local.hour)}:${pad(local.minute)}`);
}

/** `dayUtc` is an instant on the day asked about (local noon). */
export function dayTimesFor(place: Place, dayUtc: number, lang: Lang): string {
  const day: LocalParts = localPartsOf(dayUtc, ZONE);
  const sunrise = sunriseOn(dayUtc, place);
  const sunset = sunsetOn(dayUtc, place);
  const midday = sunrise !== null && sunset !== null ? Math.round((sunrise + sunset) / 2) : null;
  const he = lang === 'he';

  const rows: [string, number | null][] = he
    ? [
        ['עלות השחר', dawnOn(dayUtc, DAWN_DEGREES, place)],
        ['זריחה', sunrise],
        ['חצות היום', midday],
        ['שקיעה', sunset],
        ['צאת הכוכבים', duskOn(dayUtc, NIGHTFALL_DEGREES, place)],
      ]
    : [
        ['Dawn', dawnOn(dayUtc, DAWN_DEGREES, place)],
        ['Sunrise', sunrise],
        ['Midday', midday],
        ['Sunset', sunset],
        ['Nightfall', duskOn(dayUtc, NIGHTFALL_DEGREES, place)],
      ];
  const parts = rows.flatMap(([name, at]) => {
    const time = clock(at);
    return time ? [`${name} ${time}`] : [];
  });

  const head = he ? `זמני היום ב${place.name} · ${formatDay(day, lang)}` : `Times of day in ${place.name} · ${formatDay(day, lang)}`;
  const note = he ? '(חישוב אסטרונומי)' : '(astronomical calculation)';
  return `${head}: ${parts.join(', ')} ${note}`;
}
