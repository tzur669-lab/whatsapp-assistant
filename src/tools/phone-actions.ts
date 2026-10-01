/**
 * Phone actions as action cards (PLAN §6.20).
 *
 * The server never runs these. `resolve` turns the agent's slots into one exact,
 * validated card input; policy always answers CONFIRM through a card; the input
 * is stored as a pending row with `channel = 'card'`; and the app receives it
 * only from a signed claim that consumes that row, once. So `execute` here is a
 * refusal: reaching it would mean a card was run outside the claim.
 *
 * What the phone gets is closed: a type from a fixed list and bounded fields.
 * A contact or an app is named in words and matched on the phone; a number or a
 * package name never travels.
 */
import { z } from 'zod';
import type { ToolName } from './registry.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';
import { ToolInputError } from './types.js';
import {
  alarmSetSlots,
  appOpenSlots,
  mediaPlaySlots,
  MAX_DESTINATION_CHARS,
  MAX_LABEL_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_VARIANTS,
  messageComposeSlots,
  navGoSlots,
  settingsSetSlots,
  timerSetSlots,
} from '../nlu/slot-schemas.js';
import { applyMeridiem } from '../time/resolve.js';
import type { TimeSpec } from '../time/resolve.js';
import { cardPreview } from '../render/phone.js';
import type { CardInput } from '../render/phone.js';

const label = z.string().min(1).max(MAX_LABEL_CHARS).optional();
const queries = z.array(z.string().min(1).max(MAX_QUERY_CHARS)).min(1).max(MAX_QUERY_VARIANTS);

/** Everything a card may carry to the phone. Strict, closed, capped. */
export const cardInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('alarm'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), label }).strict(),
  z.object({ type: z.literal('timer'), seconds: z.number().int().min(60).max(24 * 60 * 60), label }).strict(),
  z
    .object({
      type: z.literal('nav'),
      app: z.enum(['waze', 'maps']),
      destination: z.string().min(1).max(MAX_DESTINATION_CHARS).optional(),
      favorite: z.enum(['home', 'work']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('app'), queries }).strict(),
  z
    .object({
      type: z.literal('settings'),
      setting: z.enum(['flashlight', 'dnd', 'ringer', 'wifi', 'bluetooth']),
      state: z.enum(['on', 'off', 'silent', 'vibrate', 'normal']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('message'),
      channel: z.enum(['sms', 'whatsapp']),
      queries,
      text: z.string().min(1).max(MAX_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      type: z.literal('media'),
      app: z.enum(['youtube', 'youtube_music']),
      query: z.string().min(1).max(MAX_QUERY_CHARS),
      mode: z.enum(['background', 'fullscreen']),
    })
    .strict(),
])
  // A navigation names a place or a saved favorite, exactly one of the two.
  .refine((value) => value.type !== 'nav' || (value.destination === undefined) !== (value.favorite === undefined));

function ready(input: CardInput): ResolveOutcome {
  const parsed = cardInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolInputError('card');
  return { kind: 'ready', input: parsed.data };
}

function missing(
  what:
    | 'destination'
    | 'app'
    | 'setting'
    | 'state'
    | 'recipient'
    | 'message'
    | 'media'
    | 'media_app'
    | 'media_app_mode'
    | 'play_mode',
): ResolveOutcome {
  return { kind: 'clarify', clarify: { code: 'phone_missing', what } };
}

/**
 * Defined once for every card tool: the preview from the validated input, and
 * an `execute` that refuses. A card runs only on the phone, after the claim.
 */
function cardTool(
  name: ToolName,
  resolve: (slots: unknown) => ResolveOutcome,
  autoRunnable: (input: CardInput) => boolean = () => true,
): ToolDefinition {
  return {
    name,
    inputSchema: cardInputSchema,
    resolve: (slots) => resolve(slots),
    preview(rawInput, lang): string {
      const input = cardInputSchema.safeParse(rawInput);
      return input.success ? cardPreview(input.data, lang) : '';
    },
    async execute(): Promise<ExecuteResult> {
      throw new ToolInputError(name);
    },
    autoRunnable(rawInput: unknown): boolean {
      const input = cardInputSchema.safeParse(rawInput);
      return input.success && autoRunnable(input.data);
    },
  };
}

const HOME = new Set(['הביתה', 'בית', 'הבית', 'לבית', 'home', 'my home']);
const WORK = new Set(['לעבודה', 'עבודה', 'העבודה', 'work', 'the office', 'office']);

/**
 * An alarm is an hour and a minute; the phone sets the next one. An hour with no
 * am/pm stays as said — "תעיר אותי ב-6" is 06:00 — which is the one place a
 * bare hour reads as morning: nobody asks to be woken at six in the evening.
 */
function alarmTime(time: TimeSpec | undefined): { hour: number; minute: number } | null {
  return time ? applyMeridiem(time) : null;
}

export const alarmSet = cardTool('alarm.set', (raw) => {
  const slots = alarmSetSlots.parse(raw);
  const at = alarmTime(slots.time as TimeSpec | undefined);
  if (!at) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'time' } };
  return ready({ type: 'alarm', hour: at.hour, minute: at.minute, ...(slots.label ? { label: slots.label } : {}) });
});

export const timerSet = cardTool('timer.set', (raw) => {
  const slots = timerSetSlots.parse(raw);
  if (slots.duration_minutes === undefined) {
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'duration' } };
  }
  return ready({ type: 'timer', seconds: slots.duration_minutes * 60, ...(slots.label ? { label: slots.label } : {}) });
});

export const navGo = cardTool('nav.go', (raw) => {
  const slots = navGoSlots.parse(raw);
  const destination = slots.destination?.trim();
  if (!destination) return missing('destination');
  const app = slots.app ?? 'waze';
  const key = destination.toLowerCase();
  if (HOME.has(key)) return ready({ type: 'nav', app, favorite: 'home' });
  if (WORK.has(key)) return ready({ type: 'nav', app, favorite: 'work' });
  return ready({ type: 'nav', app, destination });
});

export const appOpen = cardTool('app.open', (raw) => {
  const slots = appOpenSlots.parse(raw);
  if (!slots.query_variants) return missing('app');
  return ready({ type: 'app', queries: slots.query_variants });
});

/**
 * A video or a song by search words (2026-10-01). A song plays on YouTube
 * Music and a video on YouTube; which one the words are is the model's to
 * say, and when it does not, the user is asked. Background or full screen is
 * the user's choice and is asked too, never assumed: the one wrong guess plays
 * sound out loud, or covers the screen. Both missing: one question for both.
 */
export const mediaPlay = cardTool('media.play', (raw) => {
  const slots = mediaPlaySlots.parse(raw);
  const query = slots.query?.trim();
  if (!query) return missing('media');
  if (!slots.app && !slots.mode) return missing('media_app_mode');
  if (!slots.app) return missing('media_app');
  if (!slots.mode) return missing('play_mode');
  return ready({ type: 'media', app: slots.app, query, mode: slots.mode });
});

const TOGGLES = new Set(['on', 'off']);
const RINGER = new Set(['silent', 'vibrate', 'normal']);

export const settingsSet = cardTool(
  'settings.set',
  (raw) => {
    const slots = settingsSetSlots.parse(raw);
    if (!slots.setting) return missing('setting');
    const { setting, state } = slots;

    // Android lets an app open these panels, not flip the radios (§6.20).
    if (setting === 'wifi' || setting === 'bluetooth') return ready({ type: 'settings', setting });

    if (setting === 'ringer') {
      return state && RINGER.has(state) ? ready({ type: 'settings', setting, state }) : missing('state');
    }
    // "תדליק פנס" with nothing else is on; a state that names a ringer mode is not an answer.
    if (state !== undefined && !TOGGLES.has(state)) return missing('state');
    if (state === undefined && setting === 'dnd') return missing('state');
    return ready({ type: 'settings', setting, state: state ?? 'on' });
  },
  // Only the flashlight runs on its own: do-not-disturb and the ringer could
  // silence the assistant's own reminders, so they wait for the tap.
  (input) => input.type === 'settings' && input.setting === 'flashlight',
);

export const messageCompose = cardTool(
  'message.compose',
  (raw) => {
    const slots = messageComposeSlots.parse(raw);
    if (!slots.query_variants) return missing('recipient');
    if (!slots.text) return missing('message');
    return ready({
      type: 'message',
      // WhatsApp is what an Israeli user means by "a message" when they name none;
      // the card shows which one, and the user can refuse it.
      channel: slots.channel ?? 'whatsapp',
      queries: slots.query_variants,
      text: slots.text,
    });
  },
  () => false,
);

export const PHONE_ACTION_TOOLS: Readonly<Partial<Record<ToolName, ToolDefinition>>> = {
  'alarm.set': alarmSet,
  'timer.set': timerSet,
  'nav.go': navGo,
  'app.open': appOpen,
  'settings.set': settingsSet,
  'message.compose': messageCompose,
  'media.play': mediaPlay,
};
