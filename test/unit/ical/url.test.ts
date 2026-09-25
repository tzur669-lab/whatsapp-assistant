/**
 * Validating a calendar feed URL (PLAN §6.15, §11.3). Test-first per CLAUDE.md:
 * this is the security boundary of the whole feature.
 *
 * The URL is typed by the user and then fetched by a Worker, so the question is
 * not "can it be parsed" but "where does it point". The refusals are as much the
 * subject here as the acceptances.
 */
import { describe, expect, it } from 'vitest';
import { checkFeedUrl, MAX_URL_CHARS } from '../../../src/ical/url.js';

const reasonFor = (raw: string): string | null => {
  const result = checkFeedUrl(raw);
  return result.ok ? null : result.reason;
};

describe('a URL worth fetching', () => {
  it('accepts an ordinary https feed', () => {
    const result = checkFeedUrl('https://calendar.example.test/feeds/timetable.ics');
    expect(result.ok).toBe(true);
  });

  it('accepts one with a query string, which is how most of them carry a token', () => {
    expect(checkFeedUrl('https://example.test/ical?token=abc&view=full').ok).toBe(true);
  });

  it('rewrites webcal:, which is what a calendar app hands out', () => {
    // https wearing a hat. Rewriting it saves the user a step they would
    // otherwise have to know about.
    const result = checkFeedUrl('webcal://calendar.example.test/f.ics');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.startsWith('https://')).toBe(true);
  });

  it('accepts an explicit :443', () => {
    expect(checkFeedUrl('https://example.test:443/f.ics').ok).toBe(true);
  });
});

describe('a URL that is refused, and why', () => {
  it('refuses plain http, because a feed is fetched with no user watching', () => {
    expect(reasonFor('http://example.test/f.ics')).toBe('not_https');
  });

  it('refuses credentials in the URL', () => {
    // They would reach a log the moment anything printed the feed, and a feed
    // that needs them is not one to subscribe to from a shared assistant.
    expect(reasonFor('https://user:secret@example.test/f.ics')).toBe('has_credentials');
  });

  it('refuses an IP literal, in every spelling of one', () => {
    // A public feed is never published as an address. Refusing the whole form
    // removes the question of which ranges are private.
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '[::1]',
      '[fd00::1]',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
    ]) {
      expect(reasonFor(`https://${host}/f.ics`), host).toBe('ip_literal');
    }
  });

  it('refuses a private or local name', () => {
    for (const host of ['localhost', 'router.local', 'db.internal', 'nas.home', 'intranet']) {
      expect(reasonFor(`https://${host}/f.ics`), host).toBe('private_host');
    }
  });

  it('refuses a non-standard port', () => {
    // A feed on :8080 is a development server, not a subscription.
    expect(reasonFor('https://example.test:8080/f.ics')).toBe('bad_port');
    expect(reasonFor('https://example.test:22/f.ics')).toBe('bad_port');
  });

  it('refuses something that is not a URL at all', () => {
    for (const raw of ['', '   ', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(reasonFor(raw), raw).not.toBeNull();
    }
  });

  it('refuses one that is absurdly long', () => {
    expect(reasonFor(`https://example.test/${'a'.repeat(MAX_URL_CHARS)}`)).toBe('too_long');
  });

  it('names the rule that was broken, because the user probably mistyped it', () => {
    // Unlike a webhook signature, this is not an attacker to stay quiet about.
    // A reply of "not https" is one the user can act on; "invalid" is not.
    expect(reasonFor('http://example.test/f.ics')).toBe('not_https');
    expect(reasonFor('https://example.test:9000/f.ics')).toBe('bad_port');
  });
});
