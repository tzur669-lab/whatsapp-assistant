/**
 * Time rendering for replies (PLAN §6.3, "Echo format").
 *
 * Every reply that mentions a time shows weekday + date + time, because an
 * absolute echo is what lets a wrong parse be caught before it fires. Numeric
 * runs are bidi-isolated so a range cannot render reversed in Hebrew.
 */
import type { LocalParts } from '../time/tz.js';
import { isolateLtr } from './bidi.js';

export type Lang = 'he' | 'en';

/**
 * Hebrew weekday names. Sunday through Friday are written as the customary
 * letter abbreviations; Saturday has its own name and takes no letter.
 */
const HE_WEEKDAYS = ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת'] as const;
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EN_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const SEPARATOR = ' · ';

/** `יום ו׳ 25.9 · 14:00` / `Fri 25 Sep · 14:00`. */
export function formatWhen(local: LocalParts, lang: Lang): string {
  return `${weekdayOf(local, lang)} ${isolateLtr(dateOf(local, lang))}${SEPARATOR}${isolateLtr(timeOf(local))}`;
}

/** A day without a time: `יום ו׳ 25.9` / `Fri 25 Sep`. */
export function formatDay(local: LocalParts, lang: Lang): string {
  return `${weekdayOf(local, lang)} ${isolateLtr(dateOf(local, lang))}`;
}

/**
 * A range. Same-day ranges share one date and isolate the whole span, so
 * `14:00-15:00` cannot render as `15:00-14:00`.
 */
export function formatRange(start: LocalParts, end: LocalParts, lang: Lang): string {
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  if (sameDay) {
    return `${weekdayOf(start, lang)} ${isolateLtr(dateOf(start, lang))}${SEPARATOR}${isolateLtr(
      `${timeOf(start)}-${timeOf(end)}`,
    )}`;
  }
  return `${formatWhen(start, lang)} – ${formatWhen(end, lang)}`;
}

/** Hebrew dual forms are separate words, so this is not a plural suffix problem. */
export type DurationUnit = 'minute' | 'hour' | 'day';

const HE_FORMS: Record<DurationUnit, { one: string; two: string; other: string }> = {
  minute: { one: 'דקה', two: 'שתי דקות', other: 'דקות' },
  hour: { one: 'שעה', two: 'שעתיים', other: 'שעות' },
  day: { one: 'יום', two: 'יומיים', other: 'ימים' },
};

const EN_FORMS: Record<DurationUnit, { one: string; other: string }> = {
  minute: { one: 'minute', other: 'minutes' },
  hour: { one: 'hour', other: 'hours' },
  day: { one: 'day', other: 'days' },
};

const pluralRules = new Map<Lang, Intl.PluralRules>();

function rulesFor(lang: Lang): Intl.PluralRules {
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang === 'he' ? 'he-IL' : 'en');
    pluralRules.set(lang, rules);
  }
  return rules;
}

/** `שעה` · `שעתיים` · `3 שעות`. The dual never carries the digit 2. */
export function formatDuration(count: number, unit: DurationUnit, lang: Lang): string {
  if (lang === 'en') {
    const form = EN_FORMS[unit];
    const word = rulesFor('en').select(count) === 'one' ? form.one : form.other;
    return `${isolateLtr(String(count))} ${word}`;
  }

  const form = HE_FORMS[unit];
  switch (rulesFor('he').select(count)) {
    case 'one':
      return form.one;
    case 'two':
      return form.two;
    default:
      return `${isolateLtr(String(count))} ${form.other}`;
  }
}

/** A weekday by number, 0 = Sunday: `יום א׳` / `Sun`. */
export function weekdayName(weekday: number, lang: Lang): string {
  return (lang === 'he' ? HE_WEEKDAYS : EN_WEEKDAYS)[weekday] ?? '';
}

function weekdayOf(local: LocalParts, lang: Lang): string {
  const names = lang === 'he' ? HE_WEEKDAYS : EN_WEEKDAYS;
  return names[local.weekday] ?? '';
}

function dateOf(local: LocalParts, lang: Lang): string {
  // Israeli convention is day before month, dot-separated and unpadded.
  return lang === 'he'
    ? `${local.day}.${local.month}`
    : `${local.day} ${EN_MONTHS[local.month - 1] ?? ''}`;
}

function timeOf(local: LocalParts): string {
  return `${pad(local.hour)}:${pad(local.minute)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
