/**
 * Wikipedia (free, no key; 2026-10-05, ROADMAP #15): the opening of the one
 * article that best matches the query — Hebrew Wikipedia for a Hebrew query,
 * English otherwise.
 *
 * The extract is text other people wrote, so a read taints the turn, and it is
 * scrubbed on its way to the model like every read. The query is the only
 * thing sent; `info.lookup` refuses it in a turn that is already tainted, so
 * text someone else wrote can never choose what is sent out (§6.19).
 */
import { isolate } from '../render/bidi.js';
import type { Lang } from '../render/format-time.js';
import { getJson, str } from './http.js';

export const MAX_EXTRACT_CHARS = 600;
const MAX_TITLE_CHARS = 120;

const HEBREW = /[\u0590-\u05FF]/;

/** Cut at the last sentence end inside the cap, so the reply does not stop mid-word. */
export function trimExtract(text: string, max = MAX_EXTRACT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

export type WikiResult =
  | { kind: 'found'; text: string }
  | { kind: 'not_found'; text: string }
  | { kind: 'failed' };

export async function wikipediaFor(fetchImpl: typeof fetch, query: string, lang: Lang): Promise<WikiResult> {
  const wiki = HEBREW.test(query) ? 'he' : 'en';
  const base = `https://${wiki}.wikipedia.org`;
  const he = lang === 'he';
  const notFound = he ? `לא מצאתי בוויקיפדיה ערך על ${isolate(query)}.` : `I found no Wikipedia article about ${query}.`;

  const search = await getJson(fetchImpl, `${base}/w/rest.php/v1/search/title?q=${encodeURIComponent(query)}&limit=1`, {
    named: true,
  });
  if (!search.ok) return { kind: 'failed' };
  const first = (search.value as { pages?: unknown[] }).pages?.[0] as Record<string, unknown> | undefined;
  const key = str(first?.['key'], 300);
  if (!key) return { kind: 'not_found', text: notFound };

  const summary = await getJson(fetchImpl, `${base}/api/rest_v1/page/summary/${encodeURIComponent(key)}`, { named: true });
  if (!summary.ok) return { kind: 'failed' };
  const page = summary.value as Record<string, unknown>;
  const title = str(page['title'], MAX_TITLE_CHARS) ?? key.slice(0, MAX_TITLE_CHARS);
  const extract = str(page['extract'], 4000);
  if (page['type'] === 'disambiguation' || !extract) {
    return {
      kind: 'not_found',
      text: he
        ? `בוויקיפדיה יש כמה ערכים בשם ${isolate(title)}. אפשר לפרט יותר.`
        : `Wikipedia has several articles called ${title}. Try being more specific.`,
    };
  }
  const head = he ? `ויקיפדיה · ${isolate(title)}` : `Wikipedia · ${title}`;
  return { kind: 'found', text: `${head}: ${wiki === 'en' && he ? isolate(trimExtract(extract)) : trimExtract(extract)}` };
}
