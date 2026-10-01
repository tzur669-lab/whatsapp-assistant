/**
 * Where "the weather" and "candle lighting" are about. The user's home city,
 * set with `/city`, or Jerusalem until they set one; a place named in the
 * message wins for that message. Names become coordinates through Open-Meteo's
 * geocoder, which needs no key.
 */
import { getJson, num, str } from './http.js';

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
