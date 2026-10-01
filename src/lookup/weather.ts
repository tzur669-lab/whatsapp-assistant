/**
 * Weather from Open-Meteo (free, no key): the day's forecast, and on today the
 * temperature now. Numbers and a code mapped to words here — no text anyone
 * else wrote reaches the model, so this does not taint the turn.
 */
import { formatDay } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { isolateLtr } from '../render/bidi.js';
import type { LocalParts } from '../time/tz.js';
import { getJson, num } from './http.js';
import type { Place } from './place.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const FORECAST_DAYS = 16;

/** WMO weather codes, as Open-Meteo reports them. */
export function describeWeather(code: number, lang: Lang): string {
  const he = lang === 'he';
  if (code === 0) return he ? 'בהיר' : 'clear';
  if (code <= 2) return he ? 'מעונן חלקית' : 'partly cloudy';
  if (code === 3) return he ? 'מעונן' : 'overcast';
  if (code === 45 || code === 48) return he ? 'ערפל' : 'fog';
  if (code >= 51 && code <= 57) return he ? 'טפטוף' : 'drizzle';
  if (code >= 61 && code <= 67) return he ? 'גשם' : 'rain';
  if (code >= 71 && code <= 77) return he ? 'שלג' : 'snow';
  if (code >= 80 && code <= 82) return he ? 'ממטרים' : 'showers';
  if (code === 85 || code === 86) return he ? 'ממטרי שלג' : 'snow showers';
  if (code >= 95) return he ? 'סופת רעמים' : 'thunderstorm';
  return he ? 'לא ידוע' : 'unknown';
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (day: LocalParts) => `${day.year}-${pad(day.month)}-${pad(day.day)}`;

/** The forecast for one local day; `isToday` adds the temperature now. */
export async function weatherFor(
  fetchImpl: typeof fetch,
  place: Place,
  day: LocalParts,
  isToday: boolean,
  lang: Lang,
): Promise<string | null> {
  const url =
    `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&current=temperature_2m,weather_code&timezone=Asia%2FJerusalem&forecast_days=${FORECAST_DAYS}`;
  const fetched = await getJson(fetchImpl, url);
  if (!fetched.ok) return null;

  const daily = (fetched.value as { daily?: Record<string, unknown[]> }).daily;
  const dates = daily?.['time'];
  if (!daily || !Array.isArray(dates)) return null;
  const index = dates.indexOf(isoDay(day));
  const he = lang === 'he';
  const where = he ? `מזג האוויר ב${place.name}` : `Weather in ${place.name}`;
  if (index < 0) {
    return he
      ? `${where}: אין תחזית ל${formatDay(day, lang)}. התחזית מגיעה עד ${isolateLtr(String(FORECAST_DAYS))} ימים קדימה.`
      : `${where}: no forecast for ${formatDay(day, lang)}. The forecast reaches ${FORECAST_DAYS} days ahead.`;
  }

  const code = num(daily['weather_code']?.[index]);
  const max = num(daily['temperature_2m_max']?.[index]);
  const min = num(daily['temperature_2m_min']?.[index]);
  const rain = num(daily['precipitation_probability_max']?.[index]);

  const parts: string[] = [];
  if (code !== null) parts.push(describeWeather(code, lang));
  if (min !== null && max !== null) parts.push(isolateLtr(`${Math.round(min)}°–${Math.round(max)}°`));
  if (rain !== null) parts.push(he ? `סיכוי לגשם ${isolateLtr(`${Math.round(rain)}%`)}` : `rain chance ${Math.round(rain)}%`);

  let line = `${where} · ${formatDay(day, lang)}: ${parts.join(', ')}`;
  if (isToday) {
    const current = (fetched.value as { current?: Record<string, unknown> }).current;
    const now = num(current?.['temperature_2m']);
    if (now !== null) line += he ? `. עכשיו ${isolateLtr(`${Math.round(now)}°`)}` : `. Now ${Math.round(now)}°`;
  }
  return line;
}
