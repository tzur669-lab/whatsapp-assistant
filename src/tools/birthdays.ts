/**
 * `birthdays.upcoming` (ROADMAP #11, 2026-10-06): whose birthday is coming, or
 * when one person's is. Tier 0, agent-only, terminal.
 *
 * Two sources, merged in code: the local list (`/birthday`, §6.16), which
 * always works, and Google Contacts when its grant is connected. A person is
 * found by `query_variants`, matched here; the model never sees a date — the
 * scrub would blank it anyway — so code's text is the whole answer. A name
 * from Google Contacts was not typed by the user, so such a result taints.
 */
import { z } from 'zod';
import { birthdaysUpcomingSlots } from '../nlu/slot-schemas.js';
import { mergeBirthdays } from '../core/birthdays.js';
import { isolate, isolateLtr } from '../render/bidi.js';
import { formatDay, formatDuration } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import type { LocalParts } from '../time/tz.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { matchByText } from './match.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';

const DEFAULT_DAYS = 30;
const MAX_LINES = 15;

const inputSchema = z
  .object({
    queries: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
    days: z.number().int().min(1).max(90),
  })
  .strict();
type UpcomingInput = z.infer<typeof inputSchema>;

type Entry = { name: string; day: number; month: number; google: boolean };

/** The next local day this birthday falls on, today included, and how many days away. */
export function nextBirthday(day: number, month: number, nowMs: number): { local: LocalParts; daysAway: number } {
  const today = localPartsOf(nowMs, ZONE);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year, today.year + 1]) {
    // 29 February is kept on the 28th in a year without one, as the digest does.
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const realDay = month === 2 && day === 29 && !leap ? 28 : day;
    const at = Date.UTC(year, month - 1, realDay);
    if (at < todayUtc) continue;
    const weekday = new Date(at).getUTCDay();
    return {
      local: { year, month, day: realDay, hour: 0, minute: 0, weekday },
      daysAway: Math.round((at - todayUtc) / 86_400_000),
    };
  }
  // Unreachable: next year's date is never before today.
  throw new Error('E_BIRTHDAY_DATE');
}

function when(daysAway: number, lang: Lang): string {
  const he = lang === 'he';
  if (daysAway === 0) return he ? 'היום' : 'today';
  if (daysAway === 1) return he ? 'מחר' : 'tomorrow';
  return he ? `בעוד ${formatDuration(daysAway, 'day', lang)}` : `in ${formatDuration(daysAway, 'day', lang)}`;
}

function render(entries: readonly Entry[], input: UpcomingInput, nowMs: number, lang: Lang, googleDown: boolean): string {
  const he = lang === 'he';
  const dated = entries
    .map((entry) => ({ entry, ...nextBirthday(entry.day, entry.month, nowMs) }))
    .filter((item) => input.queries !== undefined || item.daysAway <= input.days)
    .sort((a, b) => a.daysAway - b.daysAway || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_LINES);

  const note = googleDown ? [he ? '(Google Contacts לא זמין כרגע, ולכן מוצגת רק הרשימה המקומית.)' : '(Google Contacts is unavailable; the local list only.)'] : [];
  if (dated.length === 0) {
    const empty = input.queries
      ? he
        ? 'לא נמצא יום הולדת בשם הזה.'
        : 'No birthday under that name.'
      : he
        ? `אין ימי הולדת ב־${isolateLtr(String(input.days))} הימים הקרובים.`
        : `No birthdays in the next ${formatDuration(input.days, 'day', lang)}.`;
    return [empty, ...note].join('\n');
  }
  const lines = dated.map(
    (item) => `• ${isolate(item.entry.name)} — ${formatDay(item.local, lang)} (${when(item.daysAway, lang)})`,
  );
  return [he ? 'ימי הולדת:' : 'Birthdays:', ...lines, ...note].join('\n');
}

export const birthdaysUpcoming: ToolDefinition = {
  name: 'birthdays.upcoming',
  inputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = birthdaysUpcomingSlots.safeParse(rawSlots);
    const data = slots.success ? slots.data : {};
    return {
      kind: 'ready',
      input: {
        ...(data.query_variants ? { queries: data.query_variants } : {}),
        days: data.days ?? DEFAULT_DAYS,
      } satisfies UpcomingInput,
    };
  },

  preview: () => 'ימי הולדת',

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<UpcomingInput>(inputSchema, rawInput, 'birthdays.upcoming');
    const local: Entry[] = (ctx.birthdays?.list(ctx.principal) ?? []).map((b) => ({ name: b.name, day: b.day, month: b.month, google: false }));

    let google: Entry[] = [];
    let googleDown = false;
    if (ctx.contacts) {
      const found = await ctx.contacts.birthdays();
      if (found.ok) {
        google = found.value.map((b) => ({ name: b.name, day: b.day, month: b.month, google: true }));
      } else if (found.error.code !== 'not_connected' && found.error.code !== 'disconnected') {
        ctx.log.warn('contacts_failed', { errorCode: found.error.code });
        googleDown = true;
      }
    }

    const merged = mergeBirthdays(local, google);
    const chosen = input.queries ? matchByText(merged, input.queries, (entry) => entry.name) : merged;
    const text = render(chosen, input, ctx.nowMs, ctx.lang, googleDown);
    // Only names that reach the text matter; a Google name among them taints.
    const shown = chosen.some((entry) => entry.google && text.includes(entry.name));
    return { text, ...(shown ? { tainting: true as const } : {}) };
  },
};
