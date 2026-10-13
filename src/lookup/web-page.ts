/**
 * Reading one public web page for `web.read` (block J, J3, 2026-10-13).
 *
 * The URL comes from the user's own message, found by code (`singleHttpsUrl`);
 * the model never supplies it. Before any request, and again for every
 * redirect, `checkPageUrl` refuses anything that is not a plain public https
 * host: no credentials, no port but 443, no IP literal of any kind, no local or
 * internal name, no single-label host. A Worker's `fetch` leaves from
 * Cloudflare's network and cannot reach the user's LAN, so with IP literals
 * refused a rebinding name can only point at public addresses: an accepted
 * residual (PLAN §6.29).
 *
 * The size cap is counted on the stream, never trusted from `Content-Length`.
 * Failures are returned as codes, never thrown; an error body is never read.
 * Pure but for the `fetchImpl` it is handed, which the tool context binds to
 * the turn's signal (`tools/turn-signal.ts`).
 */
import { USER_AGENT } from './http.js';

export const PAGE_TIMEOUT_MS = 8_000;
export const PAGE_MAX_BYTES = 300_000;
export const PAGE_MAX_REDIRECTS = 2;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** A URL that may be fetched, or null. Works on the WHATWG-canonical host (lowercase, punycode). */
export function checkPageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // `URL` drops a default :443, so any port left is another one.
  if (url.port !== '') return null;
  let host = url.hostname;
  // One root dot is the same host; a second one is an empty label.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.endsWith('.')) return null;
  // Any IPv6 literal, IPv4-mapped included.
  if (host.startsWith('[') || host.includes(':')) return null;
  // `URL` turns decimal, hex and octal IPv4 into dotted decimal; a numeric last label is never a public name.
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return url;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'״׳]+/gi;
const TRAILING = /[.,;:!?)\]}»]+$/;

/**
 * The one https URL in the text, or null: none, more than one, or a plain
 * http one. What `web.read` reads and what offers it (`pipeline.ts`).
 */
export function singleHttpsUrl(text: string): string | null {
  const found = new Set((text.match(URL_IN_TEXT) ?? []).map((url) => url.replace(TRAILING, '')));
  if (found.size !== 1) return null;
  const [only] = [...found];
  return only !== undefined && /^https:\/\//i.test(only) ? only : null;
}

export type PageError = 'blocked' | 'network' | 'status' | 'type' | 'too_big' | 'redirects';
export type Page = { ok: true; html: string; contentType: 'html' | 'text' } | { ok: false; error: PageError };

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

/** Fetch the page at `start`, following at most two redirects, each re-checked. */
export async function fetchPage(fetchImpl: typeof fetch, start: URL): Promise<Page> {
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  let current = checkPageUrl(start.href);
  if (!current) return { ok: false, error: 'blocked' };
  for (let hop = 0; hop <= PAGE_MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        redirect: 'manual',
        signal: timeout,
        headers: { accept: 'text/html,text/plain;q=0.9', 'user-agent': USER_AGENT },
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discard(response);
      if (!location) return { ok: false, error: 'status' };
      let next: URL | null;
      try {
        next = checkPageUrl(new URL(location, current).href);
      } catch {
        next = null;
      }
      if (!next) return { ok: false, error: 'blocked' };
      current = next;
      continue;
    }
    if (!response.ok) {
      await discard(response);
      return { ok: false, error: 'status' };
    }
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const contentType = type.includes('text/html') || type.includes('application/xhtml') ? 'html' : type.startsWith('text/plain') ? 'text' : null;
    if (!contentType) {
      await discard(response);
      return { ok: false, error: 'type' };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(response, PAGE_MAX_BYTES);
    } catch {
      return { ok: false, error: 'network' };
    }
    if (!bytes) return { ok: false, error: 'too_big' };
    return { ok: true, html: new TextDecoder('utf-8').decode(bytes), contentType };
  }
  return { ok: false, error: 'redirects' };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The few entities a page's text uses; the rest stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** Extracts a page's readable text: its title, headings, paragraphs and list items, one per line. */
export type PageText = (html: string) => Promise<string>;
