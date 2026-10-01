/**
 * The Hebrew calendar: the Hebrew date (computed here), and from Hebcal (free,
 * no key) the next two weeks — candle lighting and havdalah for the user's
 * place, the parasha, holidays — and the major holidays for the year ahead.
 *
 * Hebcal's titles are text another service wrote, so a read taints the turn
 * like a calendar read does (§6.19). They are scrubbed on the way to the model.
 */
import { formatDay, formatWhen } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import type { LocalParts } from '../time/tz.js';
import { getJson, str } from './http.js';
import type { Place } from './place.js';

const HEBCAL = 'https://www.hebcal.com/hebcal';
const NEAR_DAYS = 14;
const MAX_NEAR = 12;
const MAX_LATER = 10;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (day: { year: number; month: number; day: number }) => `${day.year}-${pad(day.month)}-${pad(day.day)}`;

/** `9 בתשרי 5787` — the date in the Hebrew calendar, from the platform's own ICU. */
export function hebrewDate(day: LocalParts): string {
  const noonUtc = Date.UTC(day.year, day.month - 1, day.day, 9);
  try {
    return new Intl.DateTimeFormat('he-u-ca-hebrew', {
      timeZone: ZONE,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(noonUtc));
  } catch {
    return '';
  }
}

type Item = { at: number; dateOnly: boolean; title: string; major: boolean };

function itemsOf(json: unknown): Item[] {
  const raw = (json as { items?: unknown[] }).items;
  if (!Array.isArray(raw)) return [];
  const out: Item[] = [];
  for (const entry of raw) {
    const record = entry as Record<string, unknown>;
    const title = str(record['title'], 80);
    const date = str(record['date'], 40);
    if (!title || !date) continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const at = dateOnly ? Date.parse(`${date}T09:00:00Z`) : Date.parse(date);
    if (!Number.isFinite(at)) continue;
    out.push({ at, dateOnly, title, major: record['category'] === 'holiday' && record['subcat'] === 'major' });
  }
  return out.sort((a, b) => a.at - b.at);
}

function line(item: Item, lang: Lang): string {
  const local = localPartsOf(item.at, ZONE);
  return `• ${item.dateOnly ? formatDay(local, lang) : formatWhen(local, lang)} — ${item.title}`;
}

export async function jewishCalendarFor(
  fetchImpl: typeof fetch,
  place: Place,
  day: LocalParts,
  lang: Lang,
): Promise<string | null> {
  const end = addDays({ ...day, hour: 12, minute: 0 }, 365);
  const url =
    `${HEBCAL}?v=1&cfg=json&i=on&maj=on&min=on&mod=on&s=on&c=on&lg=${lang === 'he' ? 'he' : 's'}` +
    `&geo=pos&latitude=${place.latitude}&longitude=${place.longitude}&tzid=${encodeURIComponent(ZONE)}` +
    `&start=${isoDay(day)}&end=${isoDay(end)}`;
  const fetched = await getJson(fetchImpl, url);
  if (!fetched.ok) return null;

  const items = itemsOf(fetched.value);
  const start = wallTimeToUtc({ ...day, hour: 0, minute: 0 }, ZONE);
  const startMs = start.kind === 'ok' ? start.utcMs : Date.UTC(day.year, day.month - 1, day.day) - 3 * 3_600_000;
  const nearEnd = startMs + NEAR_DAYS * 24 * 3_600_000;

  const near = items.filter((item) => item.at >= startMs && item.at < nearEnd).slice(0, MAX_NEAR);
  const later = items.filter((item) => item.at >= nearEnd && item.major).slice(0, MAX_LATER);

  const he = lang === 'he';
  const out = [
    he
      ? `לוח עברי · ${formatDay(day, lang)}: ${hebrewDate(day)} (זמנים ל${place.name})`
      : `Hebrew calendar · ${formatDay(day, lang)}: ${hebrewDate(day)} (times for ${place.name})`,
  ];
  if (near.length > 0) {
    out.push('', he ? 'בשבועיים הקרובים:' : 'The next two weeks:', ...near.map((item) => line(item, lang)));
  }
  if (later.length > 0) {
    out.push('', he ? 'חגים בהמשך השנה:' : 'Holidays later this year:', ...later.map((item) => line(item, lang)));
  }
  return out.join('\n');
}
