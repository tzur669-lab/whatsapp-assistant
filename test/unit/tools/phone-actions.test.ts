/**
 * Phone actions resolve to one exact card input, or ask (PLAN §6.20).
 */
import { describe, expect, it } from 'vitest';
import {
  alarmSet,
  appOpen,
  cardInputSchema,
  messageCompose,
  navGo,
  settingsSet,
  timerSet,
} from '../../../src/tools/phone-actions.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';

const ctx = {} as ToolContext;
const ready = (outcome: ReturnType<typeof alarmSet.resolve>) => {
  if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(outcome)}`);
  return outcome.input;
};
const time = (hour: number, extra: Record<string, string> = {}) => ({
  hour,
  minute: 0,
  meridiem: 'unspecified',
  part_of_day: 'unspecified',
  ...extra,
});

describe('alarm.set', () => {
  it('keeps a bare hour as said — an alarm at six is six in the morning', () => {
    expect(ready(alarmSet.resolve({ time: time(6) }, ctx))).toEqual({ type: 'alarm', hour: 6, minute: 0 });
  });

  it('reads the evening as the evening', () => {
    expect(ready(alarmSet.resolve({ time: time(8, { part_of_day: 'evening' }) }, ctx))).toMatchObject({ hour: 20 });
  });

  it('asks for the time rather than inventing one', () => {
    expect(alarmSet.resolve({}, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'missing_slot', slot: 'time' } });
  });

  it('previews the time in code', () => {
    const input = ready(alarmSet.resolve({ time: { hour: 6, minute: 30, meridiem: 'unspecified', part_of_day: 'unspecified' }, label: 'ריצה' }, ctx));
    expect(stripIsolates(alarmSet.preview(input, 'he'))).toBe('⏰ שעון מעורר ל-06:30 — ריצה');
  });
});

describe('timer.set', () => {
  it('counts in seconds on the phone', () => {
    expect(ready(timerSet.resolve({ duration_minutes: 10 }, ctx))).toEqual({ type: 'timer', seconds: 600 });
  });

  it('asks how long rather than guessing', () => {
    expect(timerSet.resolve({}, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'missing_slot', slot: 'duration' } });
  });

  it('says hours as hours', () => {
    expect(stripIsolates(timerSet.preview({ type: 'timer', seconds: 7_200 }, 'he'))).toBe('⏱ טיימר: שעתיים');
  });
});

describe('nav.go', () => {
  it('sends "home" to the saved favorite, not to a search for the word', () => {
    expect(ready(navGo.resolve({ destination: 'הביתה' }, ctx))).toEqual({ type: 'nav', app: 'waze', favorite: 'home' });
  });

  it('passes any other place through as words', () => {
    expect(ready(navGo.resolve({ destination: 'עזריאלי', app: 'maps' }, ctx))).toEqual({ type: 'nav', app: 'maps', destination: 'עזריאלי' });
  });

  it('asks where to', () => {
    expect(navGo.resolve({}, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'phone_missing', what: 'destination' } });
  });
});

describe('app.open', () => {
  it('sends the words, which the phone matches against its own apps', () => {
    expect(ready(appOpen.resolve({ query_variants: ['ספוטיפיי', 'Spotify'] }, ctx))).toEqual({ type: 'app', queries: ['ספוטיפיי', 'Spotify'] });
  });
});

describe('settings.set', () => {
  it('turns the flashlight on when nothing else was said', () => {
    expect(ready(settingsSet.resolve({ setting: 'flashlight' }, ctx))).toEqual({ type: 'settings', setting: 'flashlight', state: 'on' });
  });

  it('asks on or off for do-not-disturb, which changes what reaches the user', () => {
    expect(settingsSet.resolve({ setting: 'dnd' }, ctx)).toMatchObject({ kind: 'clarify' });
  });

  it('refuses a ringer mode that is not one', () => {
    expect(settingsSet.resolve({ setting: 'ringer', state: 'on' }, ctx)).toMatchObject({ kind: 'clarify' });
    expect(ready(settingsSet.resolve({ setting: 'ringer', state: 'vibrate' }, ctx))).toMatchObject({ state: 'vibrate' });
  });

  it('opens the Wi-Fi panel, since Android lets no app flip the radio', () => {
    expect(ready(settingsSet.resolve({ setting: 'wifi', state: 'off' }, ctx))).toEqual({ type: 'settings', setting: 'wifi' });
  });

  it('runs only the flashlight on its own', () => {
    expect(settingsSet.autoRunnable!({ type: 'settings', setting: 'flashlight', state: 'on' })).toBe(true);
    expect(settingsSet.autoRunnable!({ type: 'settings', setting: 'dnd', state: 'on' })).toBe(false);
    expect(settingsSet.autoRunnable!({ type: 'settings', setting: 'ringer', state: 'silent' })).toBe(false);
  });
});

describe('message.compose', () => {
  it('defaults to WhatsApp and carries the whole text', () => {
    expect(ready(messageCompose.resolve({ query_variants: ['אמא'], text: 'אני מאחר' }, ctx))).toEqual({
      type: 'message',
      channel: 'whatsapp',
      queries: ['אמא'],
      text: 'אני מאחר',
    });
  });

  it('asks who to, and what to say', () => {
    expect(messageCompose.resolve({ text: 'x' }, ctx)).toMatchObject({ clarify: { what: 'recipient' } });
    expect(messageCompose.resolve({ query_variants: ['אמא'] }, ctx)).toMatchObject({ clarify: { what: 'message' } });
  });

  it('never runs on its own', () => {
    expect(messageCompose.autoRunnable!({ type: 'message', channel: 'sms', queries: ['a'], text: 'b' })).toBe(false);
  });
});

describe('every card', () => {
  it('refuses to execute on the server — a card runs only on the phone, after the claim', async () => {
    for (const tool of [alarmSet, timerSet, navGo, appOpen, settingsSet, messageCompose]) {
      await expect(tool.execute({}, ctx)).rejects.toThrow();
    }
  });

  it('rejects a card input outside the closed shapes', () => {
    expect(cardInputSchema.safeParse({ type: 'exec', command: 'rm' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'alarm', hour: 7, minute: 0, extra: 1 }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'nav', app: 'waze', destination: 'x', favorite: 'home' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'message', channel: 'sms', queries: ['a'], text: 'x'.repeat(501) }).success).toBe(false);
  });
});
