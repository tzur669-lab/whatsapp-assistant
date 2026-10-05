/**
 * UV and air quality from Open-Meteo (free, no key; 2026-10-05, ROADMAP #14):
 * the day's highest UV index, and on today the air quality now. Numbers mapped
 * to words here — nothing anyone else wrote, so this does not taint the turn.
 */
import { formatDay } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { isolate, isolateLtr } from '../render/bidi.js';
import type { LocalParts } from '../time/tz.js';
import { FORECAST_DAYS } from './weather.js';
import { getJson, num } from './http.js';
import type { Place } from './place.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (day: LocalParts) => `${day.year}-${pad(day.month)}-${pad(day.day)}`;

/** The WHO bands Open-Meteo's UV index is reported against. */
export function uvLevel(uv: number, lang: Lang): string {
  const he = lang === 'he';
  if (uv < 3) return he ? 'נמוך' : 'low';
  if (uv < 6) return he ? 'בינוני' : 'moderate';
  if (uv < 8) return he ? 'גבוה' : 'high';
  if (uv < 11) return he ? 'גבוה מאוד' : 'very high';
  return he ? 'קיצוני' : 'extreme';
}

/** The European Air Quality Index bands. */
export function airLevel(aqi: number, lang: Lang): string {
  const he = lang === 'he';
  if (aqi <= 20) return he ? 'טובה' : 'good';
  if (aqi <= 40) return he ? 'סבירה' : 'fair';
  if (aqi <= 60) return he ? 'בינונית' : 'moderate';
  if (aqi <= 80) return he ? 'ירודה' : 'poor';
  if (aqi <= 100) return he ? 'ירודה מאוד' : 'very poor';
  return he ? 'גרועה במיוחד' : 'extremely poor';
}

export async function uvAirFor(
  fetchImpl: typeof fetch,
  place: Place,
  day: LocalParts,
  isToday: boolean,
  lang: Lang,
): Promise<string | null> {
  const where = `latitude=${place.latitude}&longitude=${place.longitude}&timezone=Asia%2FJerusalem`;
  const [forecast, air] = await Promise.all([
    getJson(fetchImpl, `${FORECAST}?${where}&daily=uv_index_max&forecast_days=${FORECAST_DAYS}`),
    isToday ? getJson(fetchImpl, `${AIR}?${where}&current=european_aqi,pm2_5`) : Promise.resolve(null),
  ]);

  const he = lang === 'he';
  const parts: string[] = [];

  if (forecast.ok) {
    const daily = (forecast.value as { daily?: Record<string, unknown[]> }).daily;
    const dates = daily?.['time'];
    const index = Array.isArray(dates) ? dates.indexOf(isoDay(day)) : -1;
    const uv = index >= 0 ? num(daily?.['uv_index_max']?.[index]) : null;
    if (uv !== null) {
      const value = isolateLtr(String(Math.round(uv * 10) / 10));
      parts.push(he ? `מדד ${isolate('UV')} מרבי ${value} (${uvLevel(uv, lang)})` : `max UV index ${value} (${uvLevel(uv, lang)})`);
    }
  }

  if (air?.ok) {
    const current = (air.value as { current?: Record<string, unknown> }).current;
    const aqi = num(current?.['european_aqi']);
    const pm25 = num(current?.['pm2_5']);
    if (aqi !== null) {
      const value = isolateLtr(String(Math.round(aqi)));
      const dust = pm25 !== null ? isolateLtr(`PM2.5 ${Math.round(pm25)} µg/m³`) : null;
      parts.push(
        he
          ? `איכות האוויר עכשיו ${airLevel(aqi, lang)} (מדד ${value}${dust ? `, ${dust}` : ''})`
          : `air quality now ${airLevel(aqi, lang)} (index ${value}${dust ? `, ${dust}` : ''})`,
      );
    }
  }

  if (parts.length === 0) return null;
  const head = he ? `קרינת ${isolate('UV')} ואיכות אוויר ב${place.name} · ${formatDay(day, lang)}` : `UV and air in ${place.name} · ${formatDay(day, lang)}`;
  return `${head}: ${parts.join('; ')}`;
}
