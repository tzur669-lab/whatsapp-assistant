/**
 * Birthdays from Google Contacts (ROADMAP #11, 2026-10-06), through the
 * `contacts` grant with `contacts.readonly`.
 *
 * The scope could read every address and number the user owns; this file asks
 * the People API for two fields only, names and birthdays, and keeps nothing
 * else. A birthday Google holds only as free text ("early March") is skipped:
 * code cannot put it on a day.
 */
import type { GoogleApi, GoogleResult } from './api.js';
import { isRealDayOfYear } from '../core/birthdays.js';

const BASE = 'https://people.googleapis.com/v1/people/me/connections';
const PAGE_SIZE = 1000;
/** Two thousand contacts. A book larger than that is read in part, newest pages last. */
const MAX_PAGES = 2;
const MAX_NAME_CHARS = 60;

export type ContactBirthday = { name: string; day: number; month: number; year: number | null };

export class ContactsClient {
  constructor(private readonly api: GoogleApi) {}

  async birthdays(): Promise<GoogleResult<ContactBirthday[]>> {
    const out: ContactBirthday[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${BASE}?personFields=names,birthdays&pageSize=${PAGE_SIZE}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const result = await this.api.call(url);
      if (!result.ok) return result;
      const value = result.value as { connections?: unknown; nextPageToken?: unknown };
      if (Array.isArray(value.connections)) {
        for (const person of value.connections) {
          const found = birthdayOf(person);
          if (found) out.push(found);
        }
      }
      pageToken = typeof value.nextPageToken === 'string' && value.nextPageToken ? value.nextPageToken : null;
      if (!pageToken) break;
    }
    return { ok: true, value: out };
  }
}

/** One person's name and birthday, or null when either is missing or not a real day. */
export function birthdayOf(person: unknown): ContactBirthday | null {
  if (typeof person !== 'object' || person === null) return null;
  const record = person as { names?: unknown; birthdays?: unknown };
  const names = Array.isArray(record.names) ? record.names : [];
  const rawName = (names[0] as { displayName?: unknown } | undefined)?.displayName;
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS) : '';
  if (!name) return null;

  const birthdays = Array.isArray(record.birthdays) ? record.birthdays : [];
  for (const entry of birthdays) {
    const date = (entry as { date?: unknown } | null)?.date as { year?: unknown; month?: unknown; day?: unknown } | undefined;
    if (!date) continue;
    const day = Number(date.day);
    const month = Number(date.month);
    if (!isRealDayOfYear(day, month)) continue;
    const year = Number(date.year);
    return { name, day, month, year: Number.isInteger(year) && year > 1900 ? year : null };
  }
  return null;
}
