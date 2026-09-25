/**
 * The eval recording, which is the only thing standing between a stopped run and
 * re-buying its answers (PLAN §11.2, §11.9).
 *
 * A full 156-case corpus costs ~155K of a 200K rolling daily budget, so a run is
 * normally stopped partway and finished with `--resume`. That makes the recording
 * a ledger of tokens already spent, and the one thing it must never do is get
 * smaller.
 *
 * It did. `writeRecording` wrote only the results accumulated in the current
 * process, and a resume walks the corpus from the start — so for most of a resume
 * the file on disk was a truncated prefix of itself, and a run that stopped there
 * destroyed every answer below the point it had reached. These cases exist
 * because that happened, mid-run, with 39 paid answers on the line.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answeredDrafts, writeRecording } from '../../evals/run-evals.js';
import type { CaseResult } from '../../evals/run-evals.js';
import { PROMPT_VERSION } from '../../../src/nlu/prompt.js';

type Recording = { provider: string; prompt: string; drafts: { id: string; draft: unknown }[] };

/** A result carrying an answer, which is all these cases need from one. */
const answered = (id: string, raw: unknown): CaseResult => ({
  id,
  intentOk: true,
  slotsOk: true,
  missingOk: true,
  inventedSlots: [],
  latencyMs: 0,
  promptTokens: 0,
  cachedTokens: 0,
  raw,
});

/** A result for a case the provider never answered — a timeout or a refusal. */
const unanswered = (id: string): CaseResult => ({
  id,
  intentOk: false,
  slotsOk: false,
  missingOk: false,
  inventedSlots: [],
  latencyMs: 0,
  promptTokens: 0,
  cachedTokens: 0,
  error: 'no_response',
});

describe('the eval recording', () => {
  let dir: string;
  let path: string;

  const read = (): Recording => JSON.parse(readFileSync(path, 'utf8')) as Recording;
  const seed = (drafts: { id: string; draft: unknown }[], prompt = PROMPT_VERSION): void => {
    writeFileSync(path, JSON.stringify({ provider: 'groq:seed', prompt, drafts }), 'utf8');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-rec-'));
    path = join(dir, 'run.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never loses an answer already on disk', () => {
    // The bug, stated as a test: five answers recorded, a resume that has only
    // reached the second case, and the last three must still be there.
    seed([
      { id: 'a', draft: { intent: 'one' } },
      { id: 'b', draft: { intent: 'two' } },
      { id: 'c', draft: { intent: 'three' } },
      { id: 'd', draft: { intent: 'four' } },
      { id: 'e', draft: { intent: 'five' } },
    ]);

    writeRecording(path, 'groq:x', [answered('a', { intent: 'one' }), answered('b', { intent: 'two' })]);

    const drafts = read().drafts;
    expect(drafts).toHaveLength(5);
    expect(drafts.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(drafts[4]?.draft).toEqual({ intent: 'five' });
  });

  it('does not let a case that failed this time erase the answer bought last time', () => {
    seed([{ id: 'a', draft: { intent: 'kept' } }]);

    writeRecording(path, 'groq:x', [unanswered('a')]);

    expect(read().drafts[0]?.draft).toEqual({ intent: 'kept' });
  });

  it('fills in a case that has no answer yet', () => {
    seed([
      { id: 'a', draft: null },
      { id: 'b', draft: { intent: 'two' } },
    ]);

    writeRecording(path, 'groq:x', [answered('a', { intent: 'bought now' })]);

    const drafts = read().drafts;
    expect(drafts[0]?.draft).toEqual({ intent: 'bought now' });
    expect(drafts[1]?.draft).toEqual({ intent: 'two' });
  });

  it('appends a case the recording has never seen, in the order it arrived', () => {
    seed([{ id: 'a', draft: { intent: 'one' } }]);

    writeRecording(path, 'groq:x', [answered('z', { intent: 'new' })]);

    expect(read().drafts.map((d) => d.id)).toEqual(['a', 'z']);
  });

  it('writes a recording from scratch when there is no file', () => {
    writeRecording(path, 'groq:x', [answered('a', { intent: 'one' }), unanswered('b')]);

    const recording = read();
    expect(recording.prompt).toBe(PROMPT_VERSION);
    expect(recording.provider).toBe('groq:x');
    expect(recording.drafts).toEqual([
      { id: 'a', draft: { intent: 'one' } },
      { id: 'b', draft: null },
    ]);
  });

  it('refuses to merge into a recording from another prompt version', () => {
    // Blending two prompt versions into one file makes every number in it
    // meaningless, and silently — the same reason `--compare` refuses outright.
    seed([{ id: 'old', draft: { intent: 'from v0' } }], 'v0-something-else');

    writeRecording(path, 'groq:x', [answered('a', { intent: 'one' })]);

    const recording = read();
    expect(recording.prompt).toBe(PROMPT_VERSION);
    expect(recording.drafts.map((d) => d.id)).toEqual(['a']);
  });

  it('counts answers rather than entries, so the run\'s own message is honest', () => {
    const written = writeRecording(path, 'groq:x', [
      answered('a', { intent: 'one' }),
      unanswered('b'),
      unanswered('c'),
    ]);

    expect(written).toBe(1);
    expect(read().drafts).toHaveLength(3);
  });

  it('reads back exactly the answers it wrote, and none of the gaps', () => {
    writeRecording(path, 'groq:x', [
      answered('a', { intent: 'one' }),
      unanswered('b'),
      answered('c', { intent: 'three' }),
    ]);

    const map = answeredDrafts(path);
    expect([...map.keys()]).toEqual(['a', 'c']);
    expect(map.get('c')).toEqual({ intent: 'three' });
  });

  it('reports no answers for a path that does not exist', () => {
    expect(answeredDrafts(join(dir, 'nothing.json')).size).toBe(0);
  });

  it('survives a checkpoint written twice in a row', () => {
    // Every case triggers one, so idempotence is not a nicety here.
    const results = [answered('a', { intent: 'one' })];
    writeRecording(path, 'groq:x', results);
    writeRecording(path, 'groq:x', results);

    expect(read().drafts).toEqual([{ id: 'a', draft: { intent: 'one' } }]);
  });
});
