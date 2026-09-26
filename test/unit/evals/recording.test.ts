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
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRecordingLock,
  answeredDrafts,
  isTransient,
  caseCost,
  deadConnection,
  spacingMs,
  scoreRecording,
  writeRecording,
} from '../../evals/run-evals.js';
import type { CaseResult, EvalCase, Recording } from '../../evals/run-evals.js';
import { PROMPT_VERSION } from '../../../src/nlu/prompt.js';

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
      // An empty answer carries its reason, so a stopped run says why.
      { id: 'b', draft: null, error: 'no_response' },
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

describe('scoring a recording against a corpus that has since grown', () => {
  const corpusCase = (id: string): EvalCase => ({
    id,
    now: '2026-09-25T10:00:00+03:00',
    input: 'whatever',
    expect: { intent: 'unsupported' },
  });

  const recording = (drafts: { id: string; draft: unknown }[]): Recording => ({
    provider: 'groq:x',
    prompt: PROMPT_VERSION,
    drafts,
  });

  it('excludes a case the recording has no entry for, rather than failing it', () => {
    // The corpus grows every time a tool is added. Counting a case written last
    // week as a failure of a model that ran the week before measures the calendar,
    // not the model.
    const { results, predates } = scoreRecording(
      recording([{ id: 'old', draft: { intent: 'unsupported', language: 'he', slots: {}, missing: [], ambiguities: [] } }]),
      [corpusCase('old'), corpusCase('added-later')],
    );

    expect(predates).toEqual(['added-later']);
    expect(results.map((r) => r.id)).toEqual(['old']);
  });

  it('still fails a case the model was asked and did not answer', () => {
    // An entry with a null draft is a question that was put and came back empty.
    // That is the model's failure and has to stay one.
    const { results, predates } = scoreRecording(recording([{ id: 'asked', draft: null }]), [
      corpusCase('asked'),
    ]);

    expect(predates).toEqual([]);
    expect(results[0]?.error).toBe('no_response');
    expect(results[0]?.intentOk).toBe(false);
  });

  it('scores an answered case on its merits', () => {
    const { results } = scoreRecording(
      recording([{ id: 'ok', draft: { intent: 'unsupported', language: 'he', slots: {}, missing: [], ambiguities: [] } }]),
      [corpusCase('ok')],
    );

    expect(results[0]?.intentOk).toBe(true);
    expect(results[0]?.error).toBeUndefined();
  });
});

describe('which failures are retried', () => {
  // The harness once composed the HTTP status onto the failure code
  // (`rate_limited:http 429`). The retry check matches the code exactly, so
  // every 429 became a permanent failure and a 156-case run burned through
  // 128 cases in two minutes with seven answers. The detail lives beside the
  // code now, and these pin that it cannot leak back in.
  it('retries a rate limit that carries an HTTP status', () => {
    const r: Pick<CaseResult, 'error' | 'detail'> = { error: 'rate_limited', detail: 'http 429' };
    expect(isTransient(r)).toBe(true);
  });

  it('retries a connection fault that carries a cause', () => {
    expect(isTransient({ error: 'network_error' })).toBe(true);
    expect(isTransient({ error: 'timeout' })).toBe(true);
  });

  it('does not retry a schema rejection, which the same prompt will reproduce', () => {
    expect(isTransient({ error: 'schema_invalid' })).toBe(false);
  });

  it('does not retry a case that succeeded', () => {
    expect(isTransient({})).toBe(false);
  });

  it('does not retry a request the provider refused as written', () => {
    // Groq answers a generation that failed the strict schema with a 400.
    // Retrying regenerates the same failure and spends the minute's tokens on it.
    expect(isTransient({ error: 'provider_error', status: 400 })).toBe(false);
    expect(isTransient({ error: 'provider_error', status: 422 })).toBe(false);
  });

  it('still retries a server fault, a request timeout and a rate limit', () => {
    expect(isTransient({ error: 'provider_error', status: 503 })).toBe(true);
    expect(isTransient({ error: 'provider_error', status: 408 })).toBe(true);
    expect(isTransient({ error: 'rate_limited', status: 429 })).toBe(true);
  });

  it('refuses a composed label outright, so the old bug cannot pass quietly', () => {
    expect(isTransient({ error: 'rate_limited:http 429' })).toBe(false);
  });
});

describe('one writer per recording', () => {
  // Two runs on one file once spent tokens on the same cases and raced each
  // other's checkpoint, because stopping a shell on Windows left the eval
  // running underneath it.
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-lock-'));
    path = join(dir, 'run.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the lock, and gives it back', () => {
    const lock = acquireRecordingLock(path);
    expect(lock.ok).toBe(true);
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid));

    if (lock.ok) lock.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('refuses a second writer while the first is alive, and names it', () => {
    // The parent of this test runner is alive for as long as the test is.
    writeFileSync(`${path}.lock`, String(process.ppid), 'utf8');

    const lock = acquireRecordingLock(path);
    expect(lock).toEqual({ ok: false, holder: process.ppid });
  });

  it('takes over a lock whose writer is gone', () => {
    // A run killed hard never releases. A pid this large is not running.
    writeFileSync(`${path}.lock`, '999999999', 'utf8');

    const lock = acquireRecordingLock(path);
    expect(lock.ok).toBe(true);
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid));
    if (lock.ok) lock.release();
  });

  it('takes over a lock file with nothing readable in it', () => {
    writeFileSync(`${path}.lock`, 'not a pid', 'utf8');
    const lock = acquireRecordingLock(path);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  });

  it('does not release a lock someone else now holds', () => {
    const lock = acquireRecordingLock(path);
    writeFileSync(`${path}.lock`, String(process.ppid), 'utf8');

    if (lock.ok) lock.release();
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.ppid));
  });
});

describe('pacing from what a case actually costs', () => {
  // gpt-oss-120b is a reasoning model. Paced from its ~1K-token prompt alone,
  // the run sent six requests a minute that each cost two to three times that,
  // and the per-minute limit answered 429.
  const live = (prompt: number, completion: number, cached = 0): CaseResult => ({
    ...answered('x', {}),
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    live: true,
  });

  it('counts the prompt and every output token, reasoning included', () => {
    expect(caseCost(live(1_000, 1_500))).toBe(2_500);
  });

  it('does not count cached prompt tokens, which Groq does not bill', () => {
    expect(caseCost(live(1_000, 1_500, 1_000))).toBe(1_500);
  });

  it('learns nothing from an answer read back out of a recording', () => {
    expect(caseCost({ ...answered('x', {}), promptTokens: 0 })).toBe(0);
  });

  it('learns nothing from a request the provider refused', () => {
    expect(caseCost({ ...unanswered('x'), live: true })).toBe(0);
  });

  it('spaces cases to fit 80% of the per-minute limit', () => {
    // 2,000 tokens a case; 80% of 8,000 a minute is 6,400.
    expect(spacingMs(2_000, 8_000, 60_000)).toBe(18_750);
  });

  it('spaces cases to fit the rolling daily limit once that is what binds', () => {
    // 2,500 tokens a case against 80% of 200,000 a day: one case every
    // 2,500/160,000 of a day, which is 22.5 minutes.
    expect(spacingMs(2_500, 200_000, 86_400_000)).toBe(1_350_000);
  });

  it('imposes nothing before any cost is known', () => {
    expect(spacingMs(0, 8_000, 60_000)).toBe(0);
  });
});

describe('a stopped run still says why each case failed', () => {
  // A gpt-oss run stopped at 10 cases with 10 nulls, and nothing on disk said
  // whether that was the model failing the strict schema or the network
  // failing the request. The reason was printed only at the end of a run that
  // never reached the end.
  let dir: string;
  let path: string;
  const read = (): Recording => JSON.parse(readFileSync(path, 'utf8')) as Recording;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-why-'));
    path = join(dir, 'run.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const refused = (id: string): CaseResult => ({
    ...unanswered(id),
    error: 'provider_error',
    detail: 'http 400',
    status: 400,
    live: true,
  });

  it('writes the failure code, detail and status next to the empty answer', () => {
    writeRecording(path, 'groq:x', [refused('a')]);
    expect(read().drafts).toEqual([
      { id: 'a', draft: null, error: 'provider_error', detail: 'http 400', status: 400 },
    ]);
  });

  it('replaces a recorded failure with a later answer, reason and all', () => {
    writeRecording(path, 'groq:x', [refused('a')]);
    writeRecording(path, 'groq:x', [answered('a', { intent: 'one' })]);
    expect(read().drafts).toEqual([{ id: 'a', draft: { intent: 'one' } }]);
  });

  it('reads the reason back when scoring, instead of guessing "no response"', () => {
    const corpus: EvalCase[] = [
      { id: 'a', now: '2026-09-25T10:00:00+03:00', input: 'x', expect: { intent: 'unsupported' } },
    ];
    const { results } = scoreRecording(
      {
        provider: 'groq:x',
        prompt: PROMPT_VERSION,
        drafts: [{ id: 'a', draft: null, error: 'provider_error', detail: 'http 400', status: 400 }],
      },
      corpus,
    );
    expect(results[0]).toMatchObject({ error: 'provider_error', detail: 'http 400', status: 400 });
    // A refusal is the model's failure, not a gap to excuse.
    expect(isTransient(results[0]!)).toBe(false);
  });

  it('still says "no response" for an old recording that carries no reason', () => {
    const corpus: EvalCase[] = [
      { id: 'a', now: '2026-09-25T10:00:00+03:00', input: 'x', expect: { intent: 'unsupported' } },
    ];
    const { results } = scoreRecording(
      { provider: 'groq:x', prompt: PROMPT_VERSION, drafts: [{ id: 'a', draft: null }] },
      corpus,
    );
    expect(results[0]?.error).toBe('no_response');
  });
});

describe('a run stops when the connection, not the case, is failing', () => {
  // Twice in one day a run walked the rest of the corpus on a connection a
  // content filter had started intercepting: every case a null, in seconds.
  const netFail = (id: string, cause = 'SELF_SIGNED_CERT_IN_CHAIN'): CaseResult => ({
    ...unanswered(id),
    error: 'network_error',
    detail: cause,
    live: true,
  });
  const ok = (id: string): CaseResult => ({ ...answered(id, {}), live: true });

  it('stops after three connection failures in a row, and names the cause', () => {
    expect(deadConnection([ok('a'), netFail('b'), netFail('c'), netFail('d')])).toBe(
      'SELF_SIGNED_CERT_IN_CHAIN',
    );
  });

  it('keeps going through fewer, or a streak an answer interrupts', () => {
    expect(deadConnection([netFail('a'), netFail('b')])).toBeNull();
    expect(deadConnection([netFail('a'), netFail('b'), ok('c'), netFail('d')])).toBeNull();
  });

  it('does not count the provider answering — a rate limit or a schema refusal', () => {
    const limited: CaseResult = { ...unanswered('x'), error: 'rate_limited', live: true };
    const refused: CaseResult = { ...unanswered('y'), error: 'provider_error', status: 400, live: true };
    expect(deadConnection([limited, refused, limited])).toBeNull();
  });

  it('ignores answers read back from a recording, which were never live', () => {
    const recordedGap: CaseResult = { ...unanswered('r'), error: 'network_error' };
    expect(deadConnection([recordedGap, recordedGap, recordedGap])).toBeNull();
  });
});
