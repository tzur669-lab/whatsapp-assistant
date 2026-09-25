/**
 * Validating a calendar feed URL (PLAN §6.15).
 *
 * This is the security boundary of the whole iCal feature, and it is a
 * different one from `channels/whatsapp/media.ts`. There the URL came from
 * Meta's own response and the danger was a redirect carrying our token; here the
 * URL is typed by the user and the danger is **where it points**.
 *
 * A Worker fetching an arbitrary URL is a request originating inside
 * Cloudflare's network. Cloudflare does not expose a cloud metadata endpoint the
 * way EC2 does, and Workers cannot reach a private network unless one is bound —
 * so the practical risk here is smaller than the usual SSRF story. It is still
 * refused explicitly rather than argued away, because "it happens not to be
 * reachable today" is a property of the platform and not of this code.
 *
 * What a feed URL may be: `https`, a hostname that is not an IP literal and not
 * a private or reserved name, no credentials, no non-standard port. Everything
 * else is refused by name, so the reply can say which rule was broken — this is
 * a URL the user typed and probably mistyped, not an attack to stay quiet about.
 */

export const MAX_URL_CHARS = 2048;

export type UrlRejection =
  | 'too_long'
  | 'malformed'
  | 'not_https'
  | 'has_credentials'
  | 'ip_literal'
  | 'private_host'
  | 'bad_port';

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: UrlRejection };

/**
 * Hostnames that never belong to a public calendar feed.
 *
 * `localhost` and the `.local` / `.internal` / `.home` suffixes are the ones a
 * person actually types by accident; the rest are here so the list reads as a
 * rule rather than as three special cases.
 */
const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);
const PRIVATE_SUFFIXES = ['.local', '.internal', '.home', '.lan', '.localdomain'];

/** Only the standard one. A feed on :8080 is a development server, not a subscription. */
const ALLOWED_PORTS = new Set(['', '443']);

export function checkFeedUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return { ok: false, reason: 'too_long' };

  // `webcal:` is what calendar apps hand out, and it is `https` wearing a hat.
  // Rewriting it is a convenience the user would otherwise have to perform.
  const normalized = /^webcal:\/\//i.test(trimmed)
    ? `https://${trimmed.slice('webcal://'.length)}`
    : trimmed;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };

  // A URL carrying credentials would put them in a log the moment anything
  // printed the feed, and a feed that needs them is not one to subscribe to
  // from a shared assistant.
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'has_credentials' };
  }

  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: 'bad_port' };

  const host = url.hostname.toLowerCase();

  // An IP literal names a machine rather than a service, and a public calendar
  // feed is never published as one. Refusing them removes the entire question of
  // which ranges are private.
  if (isIpLiteral(host)) return { ok: false, reason: 'ip_literal' };

  if (PRIVATE_HOSTS.has(host)) return { ok: false, reason: 'private_host' };
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: 'private_host' };
  }
  // A bare name with no dot resolves through the local search domain, which is
  // the same class of target by another route.
  if (!host.includes('.')) return { ok: false, reason: 'private_host' };

  return { ok: true, url: url.toString() };
}

/**
 * IPv4, IPv6 and the forms that look like neither.
 *
 * Deliberately generous about what counts: `0x7f.1`, `2130706433` and `[::1]`
 * are all IPv4 or IPv6 to a resolver even though none of them looks it, and a
 * check that only understood dotted quads would be a check in name only.
 */
function isIpLiteral(host: string): boolean {
  // `new URL` leaves IPv6 in brackets.
  if (host.startsWith('[') || host.includes(':')) return true;

  // Dotted decimal, and the octal/hex/integer spellings of the same thing.
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;

  const labels = host.split('.');
  if (labels.length >= 2 && labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label))) {
    return true;
  }

  return false;
}
