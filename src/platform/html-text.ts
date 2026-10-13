/**
 * A page's readable text, with Cloudflare's streaming `HTMLRewriter` (block J,
 * J3): native, so a 300 KB page costs little of the 10 ms CPU budget. A
 * Cloudflare API, so it lives here (invariant 11); tools get it as
 * `ToolContext.pageText` and tests hand in a fake.
 *
 * Kept: the text of `title`, `h1`–`h3`, `p` and `li`, one line each. Skipped:
 * anything inside `script`, `style`, `nav`, `footer`, `aside`, `form` or
 * `header`. Entities decoded; whitespace collapsed.
 */
import { decodeEntities } from '../lookup/web-page.js';
import type { PageText } from '../lookup/web-page.js';

const KEPT = 'title, h1, h2, h3, p, li';
const SKIPPED = 'script, style, nav, footer, aside, form, header, noscript, svg';

export const htmlText: PageText = async (html) => {
  const lines: string[] = [];
  let skip = 0;
  let open = 0;
  let current = '';
  const flush = () => {
    const line = decodeEntities(current).replace(/\s+/g, ' ').trim();
    if (line.length > 0) lines.push(line);
    current = '';
  };
  const rewriter = new HTMLRewriter()
    .on(SKIPPED, {
      element(element) {
        skip++;
        element.onEndTag(() => {
          skip--;
        });
      },
    })
    .on(KEPT, {
      element(element) {
        flush();
        open++;
        element.onEndTag(() => {
          open--;
          flush();
        });
      },
    })
    // Text once, at the document: a handler on nested kept elements (a `p`
    // inside an `li`) would see each chunk twice.
    .onDocument({
      text(chunk) {
        if (skip === 0 && open > 0) current += chunk.text;
      },
    });
  await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
  flush();
  return lines.join('\n');
};
