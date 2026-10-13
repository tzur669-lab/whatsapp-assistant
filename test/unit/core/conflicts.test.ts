/** The digest's overlap detector (block J, J5). */
import { describe, expect, it } from 'vitest';
import { findConflicts } from '../../../src/core/conflicts.js';
import type { CalendarEvent } from '../../../src/google/calendar.js';

const at = (iso: string) => Date.parse(iso);
const event = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id,
  title: id,
  startUtc: at(start),
  endUtc: at(end),
  allDay,
  createdByAssistant: false,
  etag: null,
});
const ids = (conflicts: ReturnType<typeof findConflicts>) => conflicts.map((c) => `${c.first.id}+${c.second.id}`);

describe('findConflicts', () => {
  it('finds overlapping timed events', () => {
    const events = [event('a', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'), event('b', '2026-10-14T07:30:00Z', '2026-10-14T08:30:00Z')];
    expect(ids(findConflicts(events))).toEqual(['a+b']);
  });

  it('touching ends are not a conflict', () => {
    const events = [event('a', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'), event('b', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z')];
    expect(findConflicts(events)).toEqual([]);
  });

  it('ignores all-day events', () => {
    const events = [event('day', '2026-10-13T21:00:00Z', '2026-10-14T21:00:00Z', true), event('b', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z')];
    expect(findConflicts(events)).toEqual([]);
  });

  it('one long event against two inside it, in start order', () => {
    const events = [
      event('c', '2026-10-14T09:00:00Z', '2026-10-14T09:30:00Z'),
      event('long', '2026-10-14T07:00:00Z', '2026-10-14T11:00:00Z'),
      event('b', '2026-10-14T08:00:00Z', '2026-10-14T08:30:00Z'),
    ];
    expect(ids(findConflicts(events))).toEqual(['long+b', 'long+c']);
  });

  it('the same event read twice (a feed and Google) is not a conflict', () => {
    const one = event('a', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z');
    expect(findConflicts([one, { ...one }])).toEqual([]);
  });

  it('on the fall-back night, 01:30 before and 01:30 after the change do not overlap', () => {
    // 2026-10-25: 02:00 IDT → 01:00 IST. 01:00–01:45 IDT is 22:00–22:45Z; 01:15–01:45 IST is 23:15–23:45Z.
    const events = [event('idt', '2026-10-24T22:00:00Z', '2026-10-24T22:45:00Z'), event('ist', '2026-10-24T23:15:00Z', '2026-10-24T23:45:00Z')];
    expect(findConflicts(events)).toEqual([]);
    const crossing = [event('idt', '2026-10-24T22:00:00Z', '2026-10-24T23:30:00Z'), event('ist', '2026-10-24T23:15:00Z', '2026-10-24T23:45:00Z')];
    expect(ids(findConflicts(crossing))).toEqual(['idt+ist']);
  });

  it('stops at the cap', () => {
    const events = Array.from({ length: 6 }, (_, i) => event(`e${i}`, '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'));
    expect(findConflicts(events, 3)).toHaveLength(3);
  });
});
