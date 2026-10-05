/**
 * Sunset, computed rather than looked up (PLAN §6.13).
 *
 * Needed because Shabbat begins at sunset, and sunset in Israel moves by more
 * than two and a half hours across the year: 16:38 in December, 19:49 in June.
 * A fixed "Friday 18:00" would be wrong in one direction for half the year and
 * wrong in the other for the rest, which is worse than not having the feature.
 *
 * This is the NOAA solar position algorithm, which is the standard one and is
 * accurate to well under a minute for these latitudes. It is about sixty lines
 * of arithmetic and needs no dependency, no network and no table — worth writing
 * out rather than taking on a package for (PLAN §4, "avoid heavy dependencies").
 *
 * What it is not: a halachic authority. It computes astronomical sunset. The
 * offsets that turn that into candle-lighting and into the end of Shabbat are a
 * separate decision, stated in `src/time/shabbat.ts`.
 */

/**
 * Israel, as one point.
 *
 * Jerusalem, because it is where the earliest candle-lighting in the country is
 * and erring early is the safe direction for a feature that holds messages back.
 * The whole country spans about 20 minutes of sunset, so one point is a
 * deliberate simplification rather than an oversight — and no user location is
 * involved, which is the other reason not to make it configurable.
 */
export const JERUSALEM = { latitude: 31.7683, longitude: 35.2137 } as const;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** Geometric sunset: the centre of the sun 0.833° below the horizon. */
const SUNSET_ZENITH = 90.833;

export type Place = { latitude: number; longitude: number };

/**
 * Sunset on the civil day that `atMs` falls in, at `place`.
 *
 * The day is taken from the local date at that place's longitude rather than
 * from UTC, so a call made at 22:00 local is still about that evening.
 *
 * Returns null at latitudes and dates where the sun does not set. That cannot
 * happen in Israel, but a function that lies about the arctic is a function
 * waiting to be reused somewhere it should not be.
 */
export function sunsetOn(atMs: number, place: Place = JERUSALEM): number | null {
  return solarEvent(atMs, place, SUNSET_ZENITH, 'set');
}

export function sunriseOn(atMs: number, place: Place = JERUSALEM): number | null {
  return solarEvent(atMs, place, SUNSET_ZENITH, 'rise');
}

/**
 * The sun at an arbitrary depression below the horizon, going down.
 *
 * `tzeit hakochavim` — nightfall — is commonly reckoned at 8.5° in Israel, and
 * that is a different quantity from sunset plus a fixed number of minutes: the
 * sun's descent is shallower near the summer solstice, so the same 8.5° takes
 * about two minutes longer in June than in December.
 */
export function duskOn(atMs: number, depressionDegrees: number, place: Place = JERUSALEM): number | null {
  return solarEvent(atMs, place, 90 + depressionDegrees, 'set');
}

/**
 * The sun at a depression below the horizon, coming up: `alot hashachar` —
 * dawn — at 16.1° (2026-10-05, the day's times in `info.lookup`).
 */
export function dawnOn(atMs: number, depressionDegrees: number, place: Place = JERUSALEM): number | null {
  return solarEvent(atMs, place, 90 + depressionDegrees, 'rise');
}

function solarEvent(
  atMs: number,
  place: Place,
  zenithDegrees: number,
  direction: 'rise' | 'set',
): number | null {
  // Julian day for midnight UTC of the day in question, which is what the NOAA
  // formulas are written against.
  const midnightUtc = Math.floor(atMs / MS_PER_DAY) * MS_PER_DAY;
  const julianDay = midnightUtc / MS_PER_DAY + 2440587.5;
  const century = (julianDay - 2451545) / 36525;

  const geomMeanLong = mod360(280.46646 + century * (36000.76983 + century * 0.0003032));
  const geomMeanAnom = 357.52911 + century * (35999.05029 - 0.0001537 * century);
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);

  const anomalyRad = radians(geomMeanAnom);
  const centre =
    Math.sin(anomalyRad) * (1.914602 - century * (0.004817 + 0.000014 * century)) +
    Math.sin(2 * anomalyRad) * (0.019993 - 0.000101 * century) +
    Math.sin(3 * anomalyRad) * 0.000289;

  const trueLong = geomMeanLong + centre;
  const apparentLong =
    trueLong - 0.00569 - 0.00478 * Math.sin(radians(125.04 - 1934.136 * century));

  const meanObliquity =
    23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(radians(125.04 - 1934.136 * century));

  const declination = degrees(
    Math.asin(Math.sin(radians(obliquity)) * Math.sin(radians(apparentLong))),
  );

  // The equation of time, in minutes: the difference between apparent and mean
  // solar time, which is why noon is not at 12:00.
  const varY = Math.tan(radians(obliquity / 2)) ** 2;
  const equationOfTime =
    4 *
    degrees(
      varY * Math.sin(2 * radians(geomMeanLong)) -
        2 * eccentricity * Math.sin(anomalyRad) +
        4 * eccentricity * varY * Math.sin(anomalyRad) * Math.cos(2 * radians(geomMeanLong)) -
        0.5 * varY * varY * Math.sin(4 * radians(geomMeanLong)) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * anomalyRad),
    );

  const latRad = radians(place.latitude);
  const decRad = radians(declination);
  const cosHourAngle =
    (Math.cos(radians(zenithDegrees)) - Math.sin(latRad) * Math.sin(decRad)) /
    (Math.cos(latRad) * Math.cos(decRad));

  // |cos| > 1 means the sun never reaches that altitude on this day.
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;

  const hourAngle = degrees(Math.acos(cosHourAngle));
  const solarNoonMinutes = 720 - 4 * place.longitude - equationOfTime;
  const minutesUtc =
    direction === 'set' ? solarNoonMinutes + 4 * hourAngle : solarNoonMinutes - 4 * hourAngle;

  return midnightUtc + Math.round(minutesUtc * MS_PER_MINUTE);
}

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function degrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

function mod360(value: number): number {
  return ((value % 360) + 360) % 360;
}
