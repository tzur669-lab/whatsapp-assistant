/**
 * `web.read`'s URL guard and fetch (block J, J3): only a plain public https
 * host, re-checked on every redirect, capped on the stream.
 */
import { describe, expect, it } from 'vitest';
import { checkPageUrl, decodeEntities, fetchPage, PAGE_MAX_BYTES, singleHttpsUrl } from '../../src/lookup/web-page.js';

describe('checkPageUrl', () => {
  const allowed = [
    'https://www.ynet.co.il/news/article/abc',
    'https://example.com',
    'https://example.com.:443/path?q=1#x',
    'https://EXAMPLE.com/Path',
    'https://שלום.example/', // IDN, checked on its punycode form
  ];
  const refused = [
    'http://example.com/',
    'ftp://example.com/',
    'https://user@example.com/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'https://example.com:80/',
    'https://127.0.0.1/',
    'https://0x7f.0.0.1/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://10.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://localhost/',
    'https://localhost./',
    'https://api.localhost/',
    'https://printer.local/',
    'https://example.internal./',
    'https://EXAMPLE.INTERNAL/',
    'https://router.home.arpa/',
    'https://intranet/',
    'https://example.com../',
    'not a url',
  ];
  for (const url of allowed) it(`allows ${url}`, () => expect(checkPageUrl(url)).not.toBeNull());
  for (const url of refused) it(`refuses ${url}`, () => expect(checkPageUrl(url)).toBeNull());

  it('checks an IDN host on its punycode form', () => {
    expect(checkPageUrl('https://שלום.example/')!.hostname.startsWith('xn--')).toBe(true);
    expect(checkPageUrl('https://שלום.local/')).toBeNull();
  });
});

describe('singleHttpsUrl', () => {
  it('finds the one https link, without trailing punctuation', () => {
    expect(singleHttpsUrl('תסכם לי את זה: https://example.com/a?b=1.')).toBe('https://example.com/a?b=1');
    expect(singleHttpsUrl('(https://example.com/x)')).toBe('https://example.com/x');
  });
  it('none, two, or an http one: null', () => {
    expect(singleHttpsUrl('מה נשמע')).toBeNull();
    expect(singleHttpsUrl('https://a.com https://b.com')).toBeNull();
    expect(singleHttpsUrl('http://example.com')).toBeNull();
    expect(singleHttpsUrl('https://a.com and http://b.com')).toBeNull();
  });
  it('the same link twice is one', () => {
    expect(singleHttpsUrl('https://a.com/x https://a.com/x')).toBe('https://a.com/x');
  });
});

type Hop = { status: number; location?: string; type?: string; body?: string | Uint8Array; chunks?: number };

function scripted(hops: Hop[]) {
  const asked: Array<{ url: string; redirect?: RequestInit['redirect'] }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), ...(init?.redirect ? { redirect: init.redirect } : {}) });
    const hop = hops.shift();
    if (!hop) throw new Error('no more hops');
    const headers = new Headers();
    if (hop.location) headers.set('location', hop.location);
    headers.set('content-type', hop.type ?? 'text/html; charset=utf-8');
    let body: BodyInit | null = typeof hop.body === 'string' ? hop.body : hop.body ? new Blob([hop.body]) : null;
    if (hop.chunks) {
      const chunk = new Uint8Array(64 * 1024).fill(97);
      let left = hop.chunks;
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (left-- > 0) controller.enqueue(chunk);
          else controller.close();
        },
      });
    }
    return new Response(body, { status: hop.status, headers });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

describe('fetchPage', () => {
  const start = new URL('https://example.com/a');

  it('reads a page, asking for manual redirects', async () => {
    const { fetchImpl, asked } = scripted([{ status: 200, body: '<p>שלום</p>' }]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: true, html: '<p>שלום</p>', contentType: 'html' });
    expect(asked[0]).toEqual({ url: 'https://example.com/a', redirect: 'manual' });
  });

  it('follows a public redirect, relative ones included', async () => {
    const { fetchImpl, asked } = scripted([
      { status: 301, location: 'https://www.example.com/b' },
      { status: 302, location: '/c' },
      { status: 200, body: 'ok', type: 'text/plain' },
    ]);
    expect(await fetchPage(fetchImpl, start)).toMatchObject({ ok: true, contentType: 'text' });
    expect(asked.map((a) => a.url)).toEqual(['https://example.com/a', 'https://www.example.com/b', 'https://www.example.com/c']);
  });

  it('refuses a redirect to a private host, and never asks it', async () => {
    const { fetchImpl, asked } = scripted([{ status: 302, location: 'https://127.0.0.1/admin' }]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: false, error: 'blocked' });
    expect(asked).toHaveLength(1);
  });

  it('refuses a redirect to http', async () => {
    const { fetchImpl } = scripted([{ status: 302, location: 'http://example.com/' }]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: false, error: 'blocked' });
  });

  it('stops after two redirects', async () => {
    const { fetchImpl, asked } = scripted([
      { status: 302, location: '/1' },
      { status: 302, location: '/2' },
      { status: 302, location: '/3' },
    ]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: false, error: 'redirects' });
    expect(asked).toHaveLength(3);
  });

  it('caps the size on the stream, whatever Content-Length says', async () => {
    const { fetchImpl } = scripted([{ status: 200, chunks: Math.ceil(PAGE_MAX_BYTES / (64 * 1024)) + 1 }]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: false, error: 'too_big' });
  });

  it('refuses what is not a page', async () => {
    const { fetchImpl } = scripted([{ status: 200, type: 'application/pdf', body: '%PDF' }]);
    expect(await fetchPage(fetchImpl, start)).toEqual({ ok: false, error: 'type' });
  });

  it('an error status is a code, and a network error too', async () => {
    expect(await fetchPage(scripted([{ status: 404, body: 'nope' }]).fetchImpl, start)).toEqual({ ok: false, error: 'status' });
    expect(await fetchPage(scripted([]).fetchImpl, start)).toEqual({ ok: false, error: 'network' });
  });

  it('never asks a blocked start', async () => {
    const { fetchImpl, asked } = scripted([]);
    expect(await fetchPage(fetchImpl, new URL('https://localhost/'))).toEqual({ ok: false, error: 'blocked' });
    expect(asked).toHaveLength(0);
  });
});

describe('decodeEntities', () => {
  it('decodes the common ones and leaves the rest', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#1513;&#x5DC; &bogus;')).toBe('a & b <c> של &bogus;');
  });
});
