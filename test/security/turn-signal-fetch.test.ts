/**
 * The fetch inventory (Improvement plan §3 T3 step 2, Batch 07 T3-3).
 *
 * The turn deadline is real at the network boundary only where a request takes
 * the turn's signal. Every `fetch` call site in `src/` is listed here, either on
 * the turn's path — a read tool's or the agent's model call, each combining the
 * turn signal with its own timeout via `AbortSignal.any` — or outside any agent
 * turn, with the reason. A new call site fails this test until it is placed.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A call of `fetch`, `fetchImpl`, `doFetch` or `this.fetchImpl`; not `stub.fetch` or a method named `fetch`. */
const FETCH_CALL = /(?:^|[^.\w])(?:fetch|fetchImpl|doFetch)\s*\(|this\.fetchImpl\s*\(/m;
const METHOD_DEFINITION = /^\s*async fetch\s*\(/;

/** On a turn's path: each combines the turn signal with its own timeout. */
const TURN_PATH: Record<string, string> = {
  'agent/provider.ts': 'the agent model call (`complete`, options.signal)',
  'google/api.ts': 'every Google read (`GoogleApi.call`, init.signal), via the clients’ `withSignal`',
  'google/oauth.ts': 'the token refresh a Google call chains (`refreshAccessToken`)',
  'lookup/quotes.ts': 'the portfolio’s quotes (`quote`, bound by `withTurnSignal`)',
  'ical/fetch.ts': 'a feed fetch (no tool fetches one today; reads use the cache)',
  'tools/turn-signal.ts': 'the public `fetchImpl` a tool gets (`signalledFetch`)',
};

/** On a turn's path, with the signal already in the `fetchImpl` it is handed. */
const BOUND_BY_CALLER: Record<string, string> = {
  'lookup/http.ts': 'its `fetchImpl` is the tool context’s, bound by `withTurnSignal`',
  'core/quota.ts': 'passes `init` (and its signal) through unchanged',
};

/** Never inside an agent turn's deadline. */
const OUTSIDE_A_TURN: Record<string, string> = {
  'channels/whatsapp/media.ts': 'voice download, before the turn',
  'channels/whatsapp/send.ts': 'sending the reply, after the turn',
  'device/fcm.ts': 'push, after the turn or from a write’s execute (writes take no signal)',
  'nlu/groq.ts': 'the parser, which never runs after a deadline (`pipeline.ts`)',
  'voice/groq-whisper.ts': 'transcription, before the turn',
};

const FILES = sourceFiles(SRC)
  .map((path) => ({ name: relative(SRC, path).split(sep).join('/'), code: readFileSync(path, 'utf8') }))
  .filter(({ code }) => code.split('\n').some((line) => FETCH_CALL.test(line) && !METHOD_DEFINITION.test(line)));

describe('fetch inventory: the turn signal reaches every read-path request', () => {
  it('finds the call sites', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('places every fetch call site', () => {
    const known = new Set([...Object.keys(TURN_PATH), ...Object.keys(BOUND_BY_CALLER), ...Object.keys(OUTSIDE_A_TURN)]);
    const unplaced = FILES.map((file) => file.name).filter((name) => !known.has(name));
    expect(unplaced, 'a new fetch call site: does an agent turn reach it? place it above').toEqual([]);
  });

  it('lists no file that has no fetch call any more', () => {
    const present = new Set(FILES.map((file) => file.name));
    const stale = [...Object.keys(TURN_PATH), ...Object.keys(BOUND_BY_CALLER), ...Object.keys(OUTSIDE_A_TURN)].filter(
      (name) => !present.has(name),
    );
    expect(stale).toEqual([]);
  });

  for (const name of Object.keys(TURN_PATH)) {
    it(`${name} combines the turn signal with its own`, () => {
      const file = FILES.find((f) => f.name === name);
      expect(file?.code).toMatch(/AbortSignal\.any\(/);
    });
  }
});
