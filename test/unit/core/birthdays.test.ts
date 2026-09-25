/**
 * The local birthday list (PLAN §6.16, §11.3).
 *
 * Local rather than read from Google Contacts, which would mean a third OAuth
 * scope and would hand this assistant every address the user owns in order to
 * answer a question about eight of them.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { BirthdayStore, isRealDayOfYear } from '../../../src/core/birthdays.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { matchCommand } from '../../../src/core/router.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';
/** Friday 2026-03-14, local noon. */
const NOW = Date.parse('2026-03-14T10:00:00Z');

describe('BirthdayStore', () => {
  let driver: TestSqlDriver;
  let store: BirthdayStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new BirthdayStore(driver, () => NOW);
  });
  afterEach(() => driver.close());

  it('adds and lists in calendar order', () => {
    store.add({ principal: SENDER, name: 'דנה', day: 14, month: 3 });
    store.add({ principal: SENDER, name: 'יוסי', day: 2, month: 1 });

    expect(store.list(SENDER).map((entry) => entry.name)).toEqual(['יוסי', 'דנה']);
  });

  it('replaces the entry for a name already on the list', () => {
    // Adding the same person twice is a correction, not a second person.
    store.add({ principal: SENDER, name: 'דנה', day: 14, month: 3 });
    store.add({ principal: SENDER, name: 'דנה', day: 15, month: 3 });

    const list = store.list(SENDER);
    expect(list).toHaveLength(1);
    expect(list[0]?.day).toBe(15);
  });

  it('refuses a date that exists in no year', () => {
    expect(store.add({ principal: SENDER, name: 'X', day: 30, month: 2 }).ok).toBe(false);
    expect(store.add({ principal: SENDER, name: 'X', day: 32, month: 1 }).ok).toBe(false);
    expect(store.add({ principal: SENDER, name: 'X', day: 1, month: 13 }).ok).toBe(false);
  });

  it('accepts 29 February, which exists in some years', () => {
    expect(store.add({ principal: SENDER, name: 'X', day: 29, month: 2 }).ok).toBe(true);
  });

  it('removes by name, ignoring case and surrounding space', () => {
    store.add({ principal: SENDER, name: 'Dana', day: 14, month: 3 });
    expect(store.remove(SENDER, '  dana ')).toBe(true);
    expect(store.list(SENDER)).toHaveLength(0);
  });

  it('says so when there is nothing to remove', () => {
    expect(store.remove(SENDER, 'nobody')).toBe(false);
  });

  it('keeps one sender\'s list away from another\'s', () => {
    store.add({ principal: OTHER, name: 'סוד', day: 14, month: 3 });
    expect(store.list(SENDER)).toHaveLength(0);
    expect(store.on(SENDER, NOW)).toHaveLength(0);
  });

  it('finds whose birthday is today, by the local date', () => {
    store.add({ principal: SENDER, name: 'דנה', day: 14, month: 3 });
    store.add({ principal: SENDER, name: 'יוסי', day: 15, month: 3 });

    expect(store.on(SENDER, NOW).map((entry) => entry.name)).toEqual(['דנה']);
  });

  it('marks a 29 February birthday on the 28th in a year that has no 29th', () => {
    // Skipping it three years in four would be the feature quietly not working
    // for exactly the person most likely to notice.
    store.add({ principal: SENDER, name: 'ליפ', day: 29, month: 2 });

    const in2027 = Date.parse('2027-02-28T10:00:00Z');
    expect(store.on(SENDER, in2027).map((e) => e.name)).toEqual(['ליפ']);

    // And in a leap year it falls on the day itself, not on both.
    const leapDay = Date.parse('2028-02-29T10:00:00Z');
    const leapEve = Date.parse('2028-02-28T10:00:00Z');
    expect(store.on(SENDER, leapDay).map((e) => e.name)).toEqual(['ליפ']);
    expect(store.on(SENDER, leapEve)).toHaveLength(0);
  });
});

describe('isRealDayOfYear', () => {
  it('accepts every day that exists in some year', () => {
    expect(isRealDayOfYear(29, 2)).toBe(true);
    expect(isRealDayOfYear(31, 1)).toBe(true);
    expect(isRealDayOfYear(30, 4)).toBe(true);
  });

  it('refuses days no month has', () => {
    expect(isRealDayOfYear(31, 4)).toBe(false);
    expect(isRealDayOfYear(30, 2)).toBe(false);
    expect(isRealDayOfYear(0, 1)).toBe(false);
  });
});

describe('/birthday', () => {
  it('reads a name and a date', () => {
    expect(matchCommand('/birthday דנה 14.3')).toEqual({
      kind: 'birthday',
      action: { kind: 'add', name: 'דנה', day: 14, month: 3 },
    });
  });

  it('keeps a name with spaces in it', () => {
    expect(matchCommand('/birthday אבא של רוני 2/11')).toEqual({
      kind: 'birthday',
      action: { kind: 'add', name: 'אבא של רוני', day: 2, month: 11 },
    });
  });

  it('lists with no argument', () => {
    expect(matchCommand('/birthday')).toEqual({ kind: 'birthday', action: { kind: 'list' } });
  });

  it('removes', () => {
    expect(matchCommand('/birthday מחק דנה')).toEqual({
      kind: 'birthday',
      action: { kind: 'remove', name: 'דנה' },
    });
    expect(matchCommand('/birthday remove Dana')).toEqual({
      kind: 'birthday',
      action: { kind: 'remove', name: 'Dana' },
    });
  });

  it('answers a name with no date by saying what the shape is', () => {
    // Still recognisably this command, so falling through to the parser would
    // answer "not understood" — which tells the user nothing they can use.
    expect(matchCommand('/birthday דנה')).toEqual({
      kind: 'birthday',
      action: { kind: 'malformed' },
    });
  });
});
