/**
 * Fetching a calendar feed (PLAN §6.15).
 *
 * The second half of the security boundary. `url.ts` decides whether the
 * address the user typed may be fetched at all; this decides what happens when
 * the server on the other end does something unexpected.
 *
 * Three things it refuses to be talked into:
 *
 *   - **A redirect to somewhere else.** Redirects are followed manually, at most
 *     three, and every hop is re-validated through `checkFeedUrl`. A feed that
 *     is allowed to redirect freely is a feed that can point anywhere after the
 *     user has approved it — the check would be a formality.
 *   - **A body without an end.** Read through the stream with a byte counter, so
 *     a server that never stops sending is cut off rather than exhausting the
 *     isolate. `content-length` is checked when offered and not relied on.
 *   - **Waiting forever.** One timeout across the whole thing, redirects
 *     included.
 *
 * Conditional on the stored etag, because a timetable changes a few times a
 * semester and re-downloading it daily is bandwidth nobody needs.
 */
import { checkFeedUrl } from './url.js';

export const MAX_FEED_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type FeedFetch =
  | { status: 'ok'; text: string; etag: string | null }
  /** The server says nothing has changed since the stored etag. */
  | { status: 'unchanged' }
  | { status: 'failed'; errorCode: string };

export async function fetchFeed(params: {
  url: string;
  etag?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FeedFetch> {
  const doFetch = params.fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let target = params.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = checkFeedUrl(target);
    if (!allowed.ok) return { status: 'failed', errorCode: `E_ICAL_${allowed.reason.toUpperCase()}` };

    let response: Response;
    try {
      response = await doFetch(allowed.url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          ...(params.etag ? { 'if-none-match': params.etag } : {}),
        },
        signal: deadline,
      });
    } catch {
      // Never the error's text: a fetch failure message can contain the URL,
      // and the URL can contain the token that makes the feed private.
      return { status: 'failed', errorCode: 'E_ICAL_NETWORK' };
    }

    if (response.status === 304) return { status: 'unchanged' };

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'failed', errorCode: 'E_ICAL_BAD_REDIRECT' };
      // Resolved against the current URL, then re-validated from scratch on the
      // next pass. A relative Location is legal and must not skip the check.
      try {
        target = new URL(location, allowed.url).toString();
      } catch {
        return { status: 'failed', errorCode: 'E_ICAL_BAD_REDIRECT' };
      }
      continue;
    }

    if (!response.ok) {
      return { status: 'failed', errorCode: `E_ICAL_HTTP_${response.status}` };
    }

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
      return { status: 'failed', errorCode: 'E_ICAL_TOO_LARGE' };
    }

    const text = await readCapped(response);
    if (text === null) return { status: 'failed', errorCode: 'E_ICAL_TOO_LARGE' };

    return { status: 'ok', text, etag: response.headers.get('etag') };
  }

  return { status: 'failed', errorCode: 'E_ICAL_TOO_MANY_REDIRECTS' };
}

/**
 * The body, up to the cap, or null if it goes past it.
 *
 * Streamed rather than `await response.text()`, because `content-length` is a
 * claim and not a promise: a server that omits it and keeps sending would take
 * the isolate down before the size check ever ran.
 */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_FEED_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    // Releasing matters: an abandoned reader holds the connection open.
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // `fatal: false`: a feed with one bad byte is still a feed, and a replacement
  // character in a title is better than losing a semester's timetable.
  return new TextDecoder('utf-8').decode(joined);
}
