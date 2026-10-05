/**
 * Fetching public data for `info.lookup` (2026-10-01): weather, the Hebrew
 * calendar, exchange rates, news. Public endpoints, no keys, nothing of the
 * user's sent but a place name or coordinates.
 *
 * Failures are returned, never thrown, and an error body is never read.
 */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: 'network' | 'status' | 'parse' };

const TIMEOUT_MS = 8_000;
/** Enough for a year of Hebcal events or a news feed; anything bigger is refused. */
const MAX_BYTES = 400_000;

/**
 * Wikimedia asks every client to name itself (2026-10-05). A product name only:
 * no address, no account, nothing that identifies the user.
 */
export const USER_AGENT = 'PersonalAssistantBot/1.0 (single-user, private)';

async function body(fetchImpl: typeof fetch, url: string, named = false): Promise<Fetched<string>> {
  let response: Response;
  try {
    const headers: Record<string, string> = named ? { accept: '*/*', 'user-agent': USER_AGENT } : { accept: '*/*' };
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!response.ok) return { ok: false, error: 'status' };
  try {
    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, error: 'parse' };
    return { ok: true, value: text };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function getJson(fetchImpl: typeof fetch, url: string, options: { named?: boolean } = {}): Promise<Fetched<unknown>> {
  const text = await body(fetchImpl, url, options.named === true);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch {
    return { ok: false, error: 'parse' };
  }
}

export async function getText(fetchImpl: typeof fetch, url: string): Promise<Fetched<string>> {
  return body(fetchImpl, url);
}

/** A number, or null for anything else — the APIs are trusted to exist, not to be well-formed. */
export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function str(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}
