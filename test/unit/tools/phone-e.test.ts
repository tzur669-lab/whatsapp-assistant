/**
 * Block E on the phone (2026-10-06): the call log read, navigation to a contact
 * or a calendar event, and Spotify. No network.
 */
import { describe, expect, it } from 'vitest';
import { phoneCalls, phoneReadInputSchema } from '../../../src/tools/phone-reads.js';
import { phoneReadRefused, phoneReadText } from '../../../src/render/phone-reads.js';
import { cardInputSchema, mediaPlay, navGo } from '../../../src/tools/phone-actions.js';
import { cardPreview } from '../../../src/render/phone.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const NOW = Date.parse('2026-10-06T06:00:00Z');

describe('phone.calls', () => {
  it('asks the phone for a day of calls by default, missed only when said', () => {
    expect(phoneCalls.resolve({}, {} as ToolContext)).toEqual({ kind: 'ready', input: { kind: 'calls', missed: false, hours: 24 } });
    expect(phoneCalls.resolve({ missed: true, name: 'דנה', hours: 48 }, {} as ToolContext)).toEqual({
      kind: 'ready',
      input: { kind: 'calls', name: 'דנה', missed: true, hours: 48 },
    });
    expect(phoneReadInputSchema.safeParse({ kind: 'calls', missed: false, hours: 24 * 8 }).success).toBe(false);
  });

  it('renders names, directions and an unknown number, and never a number', () => {
    const text = stripIsolates(
      phoneReadText(
        { kind: 'calls', missed: false, hours: 24 },
        [
          { sender: 'דנה', title: 'missed', at: NOW - 3_600_000 },
          { title: 'incoming', at: NOW - 7_200_000 },
          { sender: 'אבא', title: 'weird', at: NOW - 9_000_000 },
        ],
        'he',
      ),
    );
    expect(text).toBe(
      'שיחות אחרונות:\n• יום ג׳ 6.10 · 08:00 · דנה · לא נענתה\n• יום ג׳ 6.10 · 07:00 · מספר לא מזוהה · נכנסת\n• יום ג׳ 6.10 · 06:30 · אבא',
    );
    expect(phoneReadText({ kind: 'calls', missed: true, hours: 24 }, [], 'he')).toBe('אין שיחות שלא נענו.');
    expect(phoneReadRefused('calls', 'denied', 'he')).toContain('יומן השיחות');
  });
});

function calendarWith(events: CalendarEvent[]): CalendarClient {
  return { listAllEvents: async () => ({ ok: true, value: events }) } as unknown as CalendarClient;
}

const event = (title: string, location?: string): CalendarEvent => ({
  id: title,
  title,
  startUtc: NOW + 3_600_000,
  endUtc: NOW + 7_200_000,
  allDay: false,
  createdByAssistant: false,
  etag: null,
  ...(location ? { location } : {}),
});

const ctx = (calendar?: CalendarClient): ToolContext =>
  ({ principal: 'p', nowMs: NOW, lang: 'he', log: createFakeLogger(), ...(calendar ? { calendar } : {}) }) as unknown as ToolContext;

describe('nav.go, 2026-10-06', () => {
  it("navigates to a contact's address, which the phone looks up", async () => {
    const out = await navGo.resolveAsync!({ contact: ['דנה'] }, ctx());
    expect(out).toEqual({ kind: 'ready', input: { type: 'nav', app: 'waze', contact: ['דנה'] } });
    if (out.kind !== 'ready') throw new Error('expected ready');
    expect(stripIsolates(navGo.preview(out.input, 'he'))).toBe('🧭 ניווט ב-Waze לכתובת של דנה');
    expect(navGo.autoRunnable!(out.input)).toBe(true);
  });

  it("navigates to an event's location, found in code, and waits for the tap", async () => {
    const calendar = calendarWith([event('קפה עם יוסי'), event('רופא שיניים', 'הרצל 10, רחובות')]);
    const out = await navGo.resolveAsync!({ event: ['רופא'] }, ctx(calendar));
    expect(out).toEqual({ kind: 'ready', input: { type: 'nav', app: 'waze', destination: 'הרצל 10, רחובות', source: 'event' } });
    if (out.kind !== 'ready') throw new Error('expected ready');
    expect(navGo.autoRunnable!(out.input)).toBe(false);

    const next = await navGo.resolveAsync!({ next_event: true }, ctx(calendar));
    expect(next).toMatchObject({ kind: 'ready', input: { destination: 'הרצל 10, רחובות', source: 'event' } });
  });

  it('asks rather than guesses when the event has no place, or there is no such event', async () => {
    const calendar = calendarWith([event('קפה עם יוסי')]);
    expect(await navGo.resolveAsync!({ event: ['קפה'] }, ctx(calendar))).toEqual({
      kind: 'clarify',
      clarify: { code: 'phone_missing', what: 'destination' },
    });
    expect(await navGo.resolveAsync!({ event: ['טיסה'] }, ctx(calendar))).toEqual({ kind: 'clarify', clarify: { code: 'not_found' } });
    expect(await navGo.resolveAsync!({ next_event: true }, ctx())).toEqual({ kind: 'clarify', clarify: { code: 'not_connected' } });
  });

  it('still navigates to a plain place and home, as before', async () => {
    expect(await navGo.resolveAsync!({ destination: 'הביתה' }, ctx())).toEqual({ kind: 'ready', input: { type: 'nav', app: 'waze', favorite: 'home' } });
    expect(await navGo.resolveAsync!({ destination: 'תל אביב', app: 'maps' }, ctx())).toEqual({
      kind: 'ready',
      input: { type: 'nav', app: 'maps', destination: 'תל אביב' },
    });
  });
});

describe('media.play on Spotify', () => {
  it('plays without asking for a mode', () => {
    const out = mediaPlay.resolve({ app: 'spotify', query: 'אריק איינשטיין' }, ctx());
    expect(out).toEqual({ kind: 'ready', input: { type: 'media', app: 'spotify', query: 'אריק איינשטיין', mode: 'fullscreen' } });
    expect(cardInputSchema.safeParse({ type: 'media', app: 'spotify', query: 'x', mode: 'fullscreen' }).success).toBe(true);
    expect(stripIsolates(cardPreview({ type: 'media', app: 'spotify', query: 'x', mode: 'fullscreen' }, 'he'))).toBe('🎵 Spotify: x');
  });
});
