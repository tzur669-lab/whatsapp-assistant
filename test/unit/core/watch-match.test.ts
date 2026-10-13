/**
 * The watch words (block J, J4): the server's half of the shared fixture. The
 * app's `WatchMatcherFixtureTest.kt` checks the same file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeWatchText, watchMatches } from '../../../src/core/watch-match.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/watch-normalize.json', import.meta.url)), 'utf8'),
) as { normalize: Array<[string, string]>; match: Array<[string, string[], boolean]> };

describe('watch words', () => {
  for (const [input, output] of fixture.normalize) {
    it(`normalizes ${JSON.stringify(input)}`, () => expect(normalizeWatchText(input)).toBe(output));
  }
  for (const [text, keywords, expected] of fixture.match) {
    it(`${expected ? 'matches' : 'does not match'} ${JSON.stringify(keywords)} in ${JSON.stringify(text)}`, () =>
      expect(watchMatches(text, keywords)).toBe(expected));
  }
});
