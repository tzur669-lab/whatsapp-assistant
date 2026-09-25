/**
 * Fetching a calendar feed (PLAN §6.15, §11.3).
 *
 * `url.ts` decides whether the address the user typed may be fetched. This is
 * the other half: what happens when the server on the other end does something
 * the user did not agree to. A feed allowed to redirect freely can point
 * anywhere after approval, which would make the first check a formality.
 */
import { describe, expect, it } from 'vitest';
import { fetchFeed, MAX_FEED_BYTES } from '../../../src/ical/fetch.js';

const FEED = 'https://calendar.example.test/f.ics';
const BODY = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';

type Call = { url: string; headers: Record<string, string> };

/** A fake server. Each entry answers one request, in order. */
function server(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const response = responses[Math.min(index++, responses.length - 1)];
    if (!response) throw new Error('no scripted response');
    return response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const ok = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers });

const redirect = (to: string, status = 302): Response =>
  new Response(null, { status, headers: { location: to } });

describe('fetching a feed', () => {
  it('returns the body and the etag', async () => {
    const { fetchImpl } = server([ok(BODY, { etag: 'W/"abc"' })]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.text).toBe(BODY);
    expect(result.etag).toBe('W/"abc"');
  });

  it('sends the stored etag and understands 304', async () => {
    const { fetchImpl, calls } = server([new Response(null, { status: 304 })]);
    const result = await fetchFeed({ url: FEED, etag: 'W/"abc"', fetchImpl });

    expect(calls[0]?.headers['if-none-match']).toBe('W/"abc"');
    expect(result.status).toBe('unchanged');
  });

  it('follows a redirect, and re-checks where it went', async () => {
    const { fetchImpl, calls } = server([
      redirect('https://cdn.example.test/f.ics'),
      ok(BODY),
    ]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://cdn.example.test/f.ics');
  });

  it('resolves a relative redirect against the URL it came from', async () => {
    const { fetchImpl, calls } = server([redirect('/other/f.ics'), ok(BODY)]);
    await fetchFeed({ url: FEED, fetchImpl });
    expect(calls[1]?.url).toBe('https://calendar.example.test/other/f.ics');
  });

  it('refuses a redirect to somewhere the user never approved', async () => {
    // The whole reason redirects are followed by hand. An approved feed that
    // can redirect anywhere is an approval of nothing.
    for (const target of ['http://example.test/f.ics', 'https://127.0.0.1/f.ics', 'https://localhost/f.ics']) {
      const { fetchImpl, calls } = server([redirect(target), ok(BODY)]);
      const result = await fetchFeed({ url: FEED, fetchImpl });

      expect(result.status, target).toBe('failed');
      // And it never made the second request.
      expect(calls, target).toHaveLength(1);
    }
  });

  it('gives up on a redirect chain rather than following it forever', async () => {
    const { fetchImpl } = server([redirect('https://a.example.test/f.ics')]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.errorCode).toBe('E_ICAL_TOO_MANY_REDIRECTS');
  });

  it('refuses a redirect with no destination', async () => {
    const { fetchImpl } = server([new Response(null, { status: 302 })]);
    const result = await fetchFeed({ url: FEED, fetchImpl });
    expect(result.status).toBe('failed');
  });

  it('refuses a body that declares itself too large', async () => {
    const { fetchImpl } = server([ok(BODY, { 'content-length': String(MAX_FEED_BYTES + 1) })]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.errorCode).toBe('E_ICAL_TOO_LARGE');
  });

  it('refuses a body that is too large without declaring it', async () => {
    // `content-length` is a claim, not a promise. A server that omits it and
    // keeps sending would take the isolate down before any size check ran.
    const { fetchImpl } = server([ok('x'.repeat(MAX_FEED_BYTES + 1_000))]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.errorCode).toBe('E_ICAL_TOO_LARGE');
  });

  it('reports an HTTP failure by status', async () => {
    const { fetchImpl } = server([new Response('nope', { status: 404 })]);
    const result = await fetchFeed({ url: FEED, fetchImpl });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.errorCode).toBe('E_ICAL_HTTP_404');
  });

  it('reports a network failure without echoing the URL', async () => {
    // A private feed carries its token in the query string, and a thrown
    // fetch error commonly contains the URL it was given.
    const secret = 'https://calendar.example.test/f.ics?token=s3cr3t-do-not-log';
    const fetchImpl = (async () => {
      throw new Error(`failed to fetch ${secret}`);
    }) as unknown as typeof fetch;

    const result = await fetchFeed({ url: secret, fetchImpl });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.errorCode).toBe('E_ICAL_NETWORK');
    expect(result.errorCode).not.toContain('s3cr3t');
  });

  it('refuses a URL that never should have been stored', async () => {
    // Defence in depth: the URL was checked when it was subscribed, and it is
    // checked again here, because a row can be edited and a check that runs
    // once is a check that can be got around.
    const { fetchImpl, calls } = server([ok(BODY)]);
    const result = await fetchFeed({ url: 'http://127.0.0.1/f.ics', fetchImpl });

    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});
