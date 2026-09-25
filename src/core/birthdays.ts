/**
 * A local birthday list (PLAN §6.16).
 *
 * `/birthday דנה 14.3` adds one, `/birthday` lists them, `/birthday מחק דנה`
 * removes one. On the day, the daily digest leads with it.
 *
 * **Local, not from Google Contacts.** Contacts would mean a third OAuth scope —
 * a §14 security decision — and would hand this assistant every address the
 * user owns in order to answer a question about eight of them. A list the user
 * types is a worse feature and a far better trade, and it is stated here rather
 * than left as an omission somebody later "fixes".
 *
 * Names are message content: stored, never logged.
 */
import type { SqlDriver } from '../core/sql.js';
import { localPartsOf, ZONE } from '../time/tz.js';

export const MAX_NAME_CHARS = 60;
export const MAX_BIRTHDAYS = 100;

export type Birthday = {
  id: string;
  name: string;
  day: number;
  month: number;
  /** Absent for most: people know the date and not the year (§6.16). */
  year: number | null;
};

export class BirthdayStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Add one, or replace the entry for a name already on the list. */
  add(params: {
    principal: string;
    name: string;
    day: number;
    month: number;
    year?: number | null;
  }): { ok: true; birthday: Birthday } | { ok: false; reason: 'invalid_date' | 'list_full' } {
    if (!isRealDayOfYear(params.day, params.month)) return { ok: false, reason: 'invalid_date' };

    const name = params.name.trim().slice(0, MAX_NAME_CHARS);
    this.remove(params.principal, name);

    if (this.list(params.principal).length >= MAX_BIRTHDAYS) {
      return { ok: false, reason: 'list_full' };
    }

    const id = randomHex(6);
    this.sql.exec(
      'INSERT INTO birthdays (id, principal, name, day, month, year, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      params.principal,
      name,
      params.day,
      params.month,
      params.year ?? null,
      this.now(),
    );

    return { ok: true, birthday: { id, name, day: params.day, month: params.month, year: params.year ?? null } };
  }

  /** Remove by name, matched case-insensitively after trimming. */
  remove(principal: string, name: string): boolean {
    const wanted = name.trim().toLowerCase();
    const match = this.list(principal).find((entry) => entry.name.toLowerCase() === wanted);
    if (!match) return false;

    this.sql.exec('DELETE FROM birthdays WHERE id = ? AND principal = ?', match.id, principal);
    return true;
  }

  /** Everyone on the list, in calendar order. */
  list(principal: string): Birthday[] {
    return this.sql
      .exec(
        'SELECT * FROM birthdays WHERE principal = ? ORDER BY month ASC, day ASC LIMIT ?',
        principal,
        MAX_BIRTHDAYS,
      )
      .map(toBirthday);
  }

  /**
   * Whose birthday falls on the local day containing `atMs`.
   *
   * Matched on the local date rather than on an instant: a birthday is a day,
   * not a moment, and it is the same day whatever the clock does.
   */
  on(principal: string, atMs: number, zone: string = ZONE): Birthday[] {
    const local = localPartsOf(atMs, zone);

    // 29 February, in a year that has no 29 February, is marked on the 28th.
    // That is the commoner practice and the only reading that happens every
    // year; skipping it three years in four would be the feature quietly not
    // working for exactly the person most likely to notice.
    const leaplingToday =
      local.month === 2 && local.day === 28 && !isLeapYear(local.year);

    return this.list(principal).filter(
      (entry) =>
        (entry.month === local.month && entry.day === local.day) ||
        (leaplingToday && entry.month === 2 && entry.day === 29),
    );
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A day that exists in some year. February 29 does; February 30 does not. */
export function isRealDayOfYear(day: number, month: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1) return false;

  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (longest[month - 1] ?? 0);
}

function toBirthday(row: Record<string, unknown>): Birthday {
  return {
    id: String(row['id']),
    name: String(row['name']),
    day: Number(row['day']),
    month: Number(row['month']),
    year: row['year'] === null || row['year'] === undefined ? null : Number(row['year']),
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}
