/**
 * `web.read` (block J, J3, 2026-10-13): read the one public page the user's
 * message links to, so the model can summarize it. Tier 0, agent-only.
 *
 * No slots: code takes the URL from the message's own words (`userText`), and
 * only when it holds exactly one https link — the model never supplies it, so
 * it cannot point the fetch anywhere. The guard, the redirects and the size cap
 * are in `lookup/web-page.ts`; the text is extracted by the platform
 * (`ToolContext.pageText`, `HTMLRewriter`).
 *
 * The page is someone else's words: the read always taints the turn
 * (`TAINTING_TOOLS`), so any write that follows confirms, and what reaches the
 * model is scrubbed and capped (`resultForModel`).
 */
import { z } from 'zod';
import { webReadSlots } from '../nlu/slot-schemas.js';
import { checkPageUrl, fetchPage, singleHttpsUrl } from '../lookup/web-page.js';
import type { PageError } from '../lookup/web-page.js';
import { isolateLtr } from '../render/bidi.js';
import type { Lang } from '../render/format-time.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';

/** What the reply keeps of the page; the model gets at most `MAX_RESULT_CHARS` of it. */
export const WEB_READ_MAX_CHARS = 1_400;

const inputSchema = z.object({ url: z.string().max(2_048).nullable() }).strict();
type WebReadInput = z.infer<typeof inputSchema>;

type Failure = PageError | 'no_link' | 'empty';

const FAILURES: Record<Failure, { he: string; en: string }> = {
  no_link: { he: 'לא מצאתי בהודעה קישור אחד לקריאה.', en: 'I did not find one link to read in the message.' },
  blocked: {
    he: 'את הקישור הזה אי אפשר לקרוא: רק אתרים ציבוריים בכתובת https.',
    en: 'I cannot read that link: only public https sites.',
  },
  too_big: { he: 'העמוד גדול מדי לקריאה.', en: 'The page is too large to read.' },
  type: { he: 'הקישור לא מוביל לעמוד טקסט.', en: 'The link does not lead to a text page.' },
  empty: { he: 'לא מצאתי טקסט בעמוד.', en: 'I found no text on the page.' },
  network: { he: 'לא הצלחתי לקרוא את העמוד. אפשר לנסות שוב מאוחר יותר.', en: 'I could not read the page. Try again later.' },
  status: { he: 'לא הצלחתי לקרוא את העמוד. אפשר לנסות שוב מאוחר יותר.', en: 'I could not read the page. Try again later.' },
  redirects: { he: 'לא הצלחתי לקרוא את העמוד. אפשר לנסות שוב מאוחר יותר.', en: 'I could not read the page. Try again later.' },
};

function failed(code: Failure, lang: Lang, ctx: { log: { info(event: string, fields: Record<string, unknown>): void } }): ExecuteResult {
  ctx.log.info('web_read_failed', { errorCode: code });
  return { text: FAILURES[code][lang] };
}

export const webRead: ToolDefinition = {
  name: 'web.read',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    webReadSlots.parse(rawSlots ?? {});
    return { kind: 'ready', input: { url: singleHttpsUrl(ctx.userText ?? '') } satisfies WebReadInput };
  },

  preview(_rawInput, lang): string {
    return lang === 'he' ? 'קריאת עמוד' : 'Reading a page';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<WebReadInput>(inputSchema, rawInput, 'web.read');
    if (input.url === null) return failed('no_link', ctx.lang, ctx);
    const url = checkPageUrl(input.url);
    if (!url) return failed('blocked', ctx.lang, ctx);
    if (!ctx.fetchImpl || !ctx.pageText) return failed('network', ctx.lang, ctx);

    const page = await fetchPage(ctx.fetchImpl, url);
    if (!page.ok) return failed(page.error, ctx.lang, ctx);
    let text: string;
    try {
      text = page.contentType === 'html' ? await ctx.pageText(page.html) : page.html.replace(/[ \t]+/g, ' ').trim();
    } catch {
      return failed('network', ctx.lang, ctx);
    }
    if (text.trim().length === 0) return failed('empty', ctx.lang, ctx);

    const host = isolateLtr(url.hostname);
    const head = ctx.lang === 'he' ? `מהעמוד ${host}:` : `From ${host}:`;
    return { text: `${head}\n${text.slice(0, WEB_READ_MAX_CHARS)}`, tainting: true };
  },
};
