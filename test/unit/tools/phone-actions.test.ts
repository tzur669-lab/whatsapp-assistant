/**
 * Phone actions resolve to one exact card input, or ask (PLAN §6.20).
 */
import { describe, expect, it } from 'vitest';
import {
  alarmSet,
  appOpen,
  cardInputSchema,
  mediaPlay,
  messageCompose,
  navGo,
  settingsSet,
  timerSet,
} from '../../../src/tools/phone-actions.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { cardPreview } from '../../../src/render/phone.js';

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

describe('media.play', () => {
  it('plays what was named, in the app and the way chosen', () => {
    expect(ready(mediaPlay.resolve({ app: 'youtube_music', query: 'עומר אדם', mode: 'background' }, ctx))).toEqual({
      type: 'media',
      app: 'youtube_music',
      query: 'עומר אדם',
      mode: 'background',
    });
    expect(ready(mediaPlay.resolve({ app: 'youtube', query: 'מתכון לשקשוקה', mode: 'fullscreen' }, ctx))).toMatchObject({
      app: 'youtube',
    });
  });

  it('asks which app when neither a song nor a video was said, and both questions at once when both are open', () => {
    expect(mediaPlay.resolve({ query: 'עומר אדם', mode: 'background' }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'phone_missing', what: 'media_app' },
    });
    expect(mediaPlay.resolve({ query: 'עומר אדם' }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'phone_missing', what: 'media_app_mode' },
    });
  });

  it('asks what to play, then whether in the background or full screen — never guesses', () => {
    expect(mediaPlay.resolve({ mode: 'background' }, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'phone_missing', what: 'media' } });
    expect(mediaPlay.resolve({ app: 'youtube_music', query: 'עומר אדם' }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'phone_missing', what: 'play_mode' },
    });
    expect(mediaPlay.resolve({ query: '   ', mode: 'fullscreen' }, ctx)).toEqual({
      kind: 'clarify',
      clarify: { code: 'phone_missing', what: 'media' },
    });
  });

  it('shows the app, what plays and how, in the preview', () => {
    const text = stripIsolates(cardPreview({ type: 'media', app: 'youtube_music', query: 'עומר אדם', mode: 'background' }, 'he'));
    expect(text).toBe('🎵 YouTube Music: עומר אדם · ברקע');
    expect(stripIsolates(cardPreview({ type: 'media', app: 'youtube', query: 'x', mode: 'fullscreen' }, 'he'))).toBe(
      '▶️ YouTube: x · במסך מלא',
    );
  });
});

describe('every card', () => {
  it('refuses to execute on the server — a card runs only on the phone, after the claim', async () => {
    for (const tool of [alarmSet, timerSet, navGo, appOpen, settingsSet, messageCompose, mediaPlay]) {
      await expect(tool.execute({}, ctx)).rejects.toThrow();
    }
  });

  it('rejects a card input outside the closed shapes', () => {
    expect(cardInputSchema.safeParse({ type: 'exec', command: 'rm' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'alarm', hour: 7, minute: 0, extra: 1 }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'nav', app: 'waze', destination: 'x', favorite: 'home' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'message', channel: 'sms', queries: ['a'], text: 'x'.repeat(501) }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'media', app: 'deezer', query: 'x', mode: 'background' }).success).toBe(false);
    // A navigation names one target, and only a place can come from an event (2026-10-06).
    expect(cardInputSchema.safeParse({ type: 'nav', app: 'waze', destination: 'x', contact: ['דנה'] }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'nav', app: 'waze', contact: ['דנה'], source: 'event' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'nav', app: 'waze' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'media', app: 'youtube', query: 'x', mode: 'pip' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ type: 'media', app: 'youtube', query: 'x'.repeat(101), mode: 'background' }).success).toBe(false);
  });
});
