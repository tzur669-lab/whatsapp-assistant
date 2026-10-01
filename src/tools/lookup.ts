/**
 * `info.lookup` (2026-10-01): public data the agent can read — weather, the
 * Hebrew calendar, exchange rates, news. Tier 0, agent-only.
 *
 * Each source fetches and renders in code (`src/lookup/`); the model gets the
 * rendered text, scrubbed, like any read. News and Hebcal titles are text
 * someone else wrote, so those results taint the turn; weather and rates are
 * numbers and code-made words, and do not.
 */
import { z } from 'zod';
import { infoLookupSlots, LOOKUP_TOPICS } from '../nlu/slot-schemas.js';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec } from '../time/resolve.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { DEFAULT_PLACE, findPlace, HOME_CITY_KEY, MAX_PLACE_CHARS } from '../lookup/place.js';
import type { Place } from '../lookup/place.js';
import { weatherFor } from '../lookup/weather.js';
import { jewishCalendarFor } from '../lookup/jewish.js';
import { ratesFor } from '../lookup/rates.js';
import { newsFor } from '../lookup/news.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const inputSchema = z
  .object({
    topic: z.enum(LOOKUP_TOPICS),
    place: z.string().min(1).max(MAX_PLACE_CHARS).optional(),
    /** Local noon of the day asked about, as an instant. */
    dayUtc: z.number().int().positive(),
    isToday: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    amount: z.number().positive().max(1_000_000_000).optional(),
  })
  .strict();

type LookupInput = z.infer<typeof inputSchema>;

/** Topics whose text was written by someone else (§6.19). */
const TAINTING_TOPICS: ReadonlySet<LookupInput['topic']> = new Set(['news', 'jewish_calendar']);

const unavailable = (lang: 'he' | 'en') =>
  lang === 'he' ? 'המידע לא זמין כרגע. אפשר לנסות שוב בעוד רגע.' : 'That information is unavailable right now. Try again in a moment.';

export const infoLookup: ToolDefinition = {
  name: 'info.lookup',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = infoLookupSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    const { topic, place, date, currency, amount } = slots.data;

    // A day is resolved by the time rules like every other date, at noon so no
    // hour rule turns it into a question. None named: today.
    let dayUtc = ctx.nowMs;
    if (date) {
      const when = resolveWhen(
        { date: date as DateSpec, time: { hour: 12, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        { nowMs: ctx.nowMs },
      );
      if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };
      dayUtc = when.utcMs;
    }
    const day = localPartsOf(dayUtc, ZONE);
    const today = localPartsOf(ctx.nowMs, ZONE);
    const isToday = day.year === today.year && day.month === today.month && day.day === today.day;

    return {
      kind: 'ready',
      input: {
        topic,
        ...(place ? { place: place.trim().slice(0, MAX_PLACE_CHARS) } : {}),
        dayUtc,
        isToday,
        ...(currency ? { currency: currency.toUpperCase() } : {}),
        ...(amount !== undefined ? { amount } : {}),
      } satisfies LookupInput,
    };
  },

  preview(): string {
    return 'מידע ציבורי';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<LookupInput>(inputSchema, rawInput, 'info.lookup');
    const fetchImpl = ctx.fetchImpl;
    if (!fetchImpl) return { text: unavailable(ctx.lang) };
    const day = localPartsOf(input.dayUtc, ZONE);

    let text: string | null = null;
    switch (input.topic) {
      case 'weather': {
        const place = await placeFor(input.place, ctx, fetchImpl);
        if (!place) return { text: placeNotFound(input.place ?? '', ctx.lang) };
        text = await weatherFor(fetchImpl, place, day, input.isToday, ctx.lang);
        break;
      }
      case 'jewish_calendar': {
        const place = await placeFor(input.place, ctx, fetchImpl);
        if (!place) return { text: placeNotFound(input.place ?? '', ctx.lang) };
        text = await jewishCalendarFor(fetchImpl, place, day, ctx.lang);
        break;
      }
      case 'exchange_rate':
        text = await ratesFor(fetchImpl, input.currency, input.amount, ctx.lang);
        break;
      case 'news':
        text = await newsFor(fetchImpl, ctx.lang);
        break;
    }

    if (text === null) {
      ctx.log.warn('lookup_failed', { topic: input.topic });
      return { text: unavailable(ctx.lang) };
    }
    return { text, ...(TAINTING_TOPICS.has(input.topic) ? { tainting: true as const } : {}) };
  },
};

/** The place named in the message, else the home city (`/city`), else Jerusalem. */
async function placeFor(named: string | undefined, ctx: ToolContext, fetchImpl: typeof fetch): Promise<Place | null> {
  const wanted = named ?? ctx.repo.getSetting(HOME_CITY_KEY);
  if (!wanted) return DEFAULT_PLACE;
  return findPlace(fetchImpl, wanted);
}

function placeNotFound(place: string, lang: 'he' | 'en'): string {
  return lang === 'he' ? `לא מצאתי מקום בשם ${place}.` : `I could not find a place called ${place}.`;
}
