/**
 * Headlines from a news site's RSS feed (ynet, free). Titles only: no
 * descriptions, no links. Text someone else wrote, so a read taints the turn,
 * and it is scrubbed on the way to the model (§6.19).
 *
 * The feed is parsed with two regular expressions rather than an XML library:
 * only `<item><title>` is read, and a feed that is not shaped that way yields
 * nothing rather than something wrong.
 */
import type { Lang } from '../render/format-time.js';
import { getText } from './http.js';

export const NEWS_FEED = 'https://www.ynet.co.il/Integration/StoryRss2.xml';
const MAX_HEADLINES = 8;
const MAX_TITLE = 160;

const ITEM = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

function decode(text: string): string {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d{1,5});/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headlinesOf(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(ITEM)) {
    const title = TITLE.exec(match[1] ?? '')?.[1];
    if (!title) continue;
    const text = decode(title.trim()).slice(0, MAX_TITLE);
    if (text) out.push(text);
    if (out.length >= MAX_HEADLINES) break;
  }
  return out;
}

export async function newsFor(fetchImpl: typeof fetch, lang: Lang): Promise<string | null> {
  const fetched = await getText(fetchImpl, NEWS_FEED);
  if (!fetched.ok) return null;
  const headlines = headlinesOf(fetched.value);
  if (headlines.length === 0) return null;
  return [lang === 'he' ? 'כותרות ynet:' : 'ynet headlines:', ...headlines.map((h) => `• ${h}`)].join('\n');
}
