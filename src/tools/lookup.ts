/**
 * `info.lookup` (2026-10-01): public data the agent can read — weather, the
 * Hebrew calendar, exchange rates, news; since 2026-10-05 also the day's times,
 * UV and air quality, and Wikipedia. Tier 0, agent-only.
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
import { currentPlace, DEFAULT_PLACE, findPlace, HOME_CITY_KEY, MAX_PLACE_CHARS } from '../lookup/place.js';
import type { Place } from '../lookup/place.js';
import { weatherFor } from '../lookup/weather.js';
import { jewishCalendarFor } from '../lookup/jewish.js';
import { ratesFor } from '../lookup/rates.js';
import { newsFor } from '../lookup/news.js';
import { dayTimesFor } from '../lookup/day-times.js';
import { uvAirFor } from '../lookup/uv-air.js';
import { wikipediaFor } from '../lookup/wikipedia.js';
import { MAX_QUERY_CHARS } from '../nlu/slot-schemas.js';
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
    query: z.string().min(1).max(MAX_QUERY_CHARS).optional(),
  })
  .strict();

type LookupInput = z.infer<typeof inputSchema>;

/** What a lookup needs from its caller: a turn's context, or the alarm's (#7). */
export type LookupContext = Pick<ToolContext, 'lang' | 'repo' | 'log' | 'location' | 'fetchImpl' | 'tainted'>;

/** Topics whose text was written by someone else (§6.19). */
const TAINTING_TOPICS: ReadonlySet<LookupInput['topic']> = new Set(['news', 'jewish_calendar', 'wikipedia']);

export const unavailable = (lang: 'he' | 'en') =>
  lang === 'he' ? 'המידע לא זמין כרגע. אפשר לנסות שוב בעוד רגע.' : 'That information is unavailable right now. Try again in a moment.';

export const infoLookup: ToolDefinition = {
  name: 'info.lookup',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = infoLookupSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    const { topic, place, date, currency, amount, query } = slots.data;
    // Wikipedia needs something to look up; there is no "the article".
    const wanted = query?.trim();
    if (topic === 'wikipedia' && !wanted) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };

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
        ...(topic === 'wikipedia' && wanted ? { query: wanted } : {}),
      } satisfies LookupInput,
    };
  },

  preview(): string {
    return 'מידע ציבורי';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    return runLookup(parseInput<LookupInput>(inputSchema, rawInput, 'info.lookup'), ctx);
  },
};

/**
 * Fetch and render one lookup. Shared by `info.lookup` and by a scheduled read
 * at its due time (ROADMAP #7), which has no model and no turn: code computes
 * the answer, and code sends it.
 */
export async function runLookup(input: LookupInput, ctx: LookupContext): Promise<ExecuteResult> {
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
    case 'day_times': {
      const place = await placeFor(input.place, ctx, fetchImpl);
      if (!place) return { text: placeNotFound(input.place ?? '', ctx.lang) };
      text = dayTimesFor(place, input.dayUtc, ctx.lang);
      break;
    }
    case 'uv_air': {
      const place = await placeFor(input.place, ctx, fetchImpl);
      if (!place) return { text: placeNotFound(input.place ?? '', ctx.lang) };
      text = await uvAirFor(fetchImpl, place, day, input.isToday, ctx.lang);
      break;
    }
    case 'wikipedia': {
      // The query is the one thing this sends out. In a turn that already
      // read someone else's text, that text could be choosing it (§6.19).
      if (ctx.tainted) return { text: wikiRefused(ctx.lang) };
      if (!input.query) return { text: unavailable(ctx.lang) };
      const found = await wikipediaFor(fetchImpl, input.query, ctx.lang);
      if (found.kind === 'failed') break;
      // A disambiguation names Wikipedia's titles, so every answer taints.
      return { text: found.text, tainting: true };
    }
  }

  if (text === null) {
    ctx.log.warn('lookup_failed', { topic: input.topic });
    return { text: unavailable(ctx.lang) };
  }
  return { text, ...(TAINTING_TOPICS.has(input.topic) ? { tainting: true as const } : {}) };
}

/**
 * The place named in the message, else where the phone is now (when the app
 * sent it), else the home city (`/city`), else Jerusalem.
 */
async function placeFor(named: string | undefined, ctx: LookupContext, fetchImpl: typeof fetch): Promise<Place | null> {
  if (!named && ctx.location) return currentPlace(ctx.location, ctx.lang);
  const wanted = named ?? ctx.repo.getSetting(HOME_CITY_KEY);
  if (!wanted) return DEFAULT_PLACE;
  return findPlace(fetchImpl, wanted);
}

function wikiRefused(lang: 'he' | 'en'): string {
  return lang === 'he'
    ? 'אחרי קריאת מידע שאחרים כתבו, חיפוש בוויקיפדיה לא זמין באותה פנייה. אפשר לשאול שוב בהודעה נפרדת.'
    : 'After reading text others wrote, I do not search Wikipedia in the same request. Ask again in a new message.';
}

function placeNotFound(place: string, lang: 'he' | 'en'): string {
  return lang === 'he' ? `לא מצאתי מקום בשם ${place}.` : `I could not find a place called ${place}.`;
}
