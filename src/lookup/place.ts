/**
 * Where "the weather" and "candle lighting" are about. A place named in the
 * message wins for that message; then where the phone is, when the app sent
 * its location with the message; then the user's home city, set with
 * `/city`; then Jerusalem. Names become coordinates through Open-Meteo's
 * geocoder, which needs no key.
 */
import { getJson, num, str } from './http.js';
import type { DeviceLocation } from '../channels/types.js';

export type Place = { name: string; latitude: number; longitude: number };

export const DEFAULT_PLACE: Place = { name: 'ירושלים', latitude: 31.7683, longitude: 35.2137 };

export const HOME_CITY_KEY = 'home_city';
export const MAX_PLACE_CHARS = 60;

const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';

export async function findPlace(fetchImpl: typeof fetch, name: string): Promise<Place | null> {
  const query = name.trim().slice(0, MAX_PLACE_CHARS);
  if (query === '') return null;
  if (query === DEFAULT_PLACE.name) return DEFAULT_PLACE;
  const url = `${GEOCODER}?name=${encodeURIComponent(query)}&count=1&language=he&format=json`;
  const fetched = await getJson(fetchImpl, url);
  if (!fetched.ok) return null;
  const first = (fetched.value as { results?: unknown[] }).results?.[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const latitude = num(first['latitude']);
  const longitude = num(first['longitude']);
  if (latitude === null || longitude === null) return null;
  return { name: str(first['name'], MAX_PLACE_CHARS) ?? query, latitude, longitude };
}

/**
 * The phone's location as a place (2026-10-01). Rounded again to two decimals,
 * about a kilometre, whatever the app sent. It has no name: the reply says
 * "your current location", so no coordinates and no reverse lookup are needed.
 */
export function currentPlace(location: DeviceLocation, lang: 'he' | 'en'): Place {
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    name: lang === 'he' ? 'מיקום הנוכחי שלך' : 'your current location',
    latitude: round(location.latitude),
    longitude: round(location.longitude),
  };
}
