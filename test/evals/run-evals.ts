/**
 * NLU eval harness (PLAN §11.2).
 *
 * Runs the case corpus against a real provider and reports the six metrics from
 * the plan. Two of them are hard gates: "no invented slot values" and
 * "missing-slot detection" must be 100%, because a bot that quietly makes up a
 * time is worse than one that asks.
 *
 * Usage:
 *   pnpm eval                       # default model
 *   pnpm eval --model <id>          # compare candidates
 *   pnpm eval --provider rules      # score the deterministic fallback
 *   pnpm eval --filter he-rem       # a subset, while iterating
 *   pnpm eval --record <file>       # keep the raw drafts, checkpointed per case
 *   pnpm eval --resume <file>       # finish a run the token budget cut short
 *   pnpm eval --wait 90             # sit out daily-budget waits, up to 90 min
 *   pnpm eval --replay <file>       # re-score a recording, no network, no budget
 *
 * Needs GROQ_API_KEY in .dev.vars for the real providers.
 *
 * Groq's 200K tokens/day cap is a **rolling** window, not a midnight reset: an
 * exhausted run reports `retry-after` in single-digit minutes. A full 156-case
 * run costs ~155K of it, so it will normally hit the cap partway through. That
 * is what `--record` and `--resume` are for: every answer is written down as it
 * arrives, and a second invocation finishes the corpus instead of re-buying the
 * part already paid for.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGroqProvider } from '../../src/nlu/groq.js';
import { createRulesProvider } from '../../src/nlu/rules-fallback.js';
import { validateIntentDraft } from '../../src/nlu/intent-schema.js';
import type { IntentDraft } from '../../src/nlu/intent-schema.js';
import type { NluProvider } from '../../src/nlu/provider.js';
import { toolCatalog } from '../../src/tools/registry.js';
import { PROMPT_VERSION, estimatePromptTokens } from '../../src/nlu/prompt.js';
import { resolveWhen } from '../../src/time/resolve.js';
import type { DateSpec, TimeSpec } from '../../src/time/resolve.js';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Groq free-tier limits per model (PLAN §2, verified 2026-09-24). */
const TOKENS_PER_MINUTE = 8_000;
const TOKENS_PER_DAY = 200_000;

export type EvalCase = {
  id: string;
  now: string;
  input: string;
  expect: {
    intent: string;
    slots?: Record<string, unknown>;
    missing?: string[];
  };
};

type CaseResult = {
  id: string;
  intentOk: boolean;
  slotsOk: boolean;
  missingOk: boolean;
  inventedSlots: string[];
  latencyMs: number;
  promptTokens: number;
  cachedTokens: number;
  error?: string;
  /** Provider `retry-after`, in seconds. A long one means the daily budget is gone. */
  retryAfterSeconds?: number;
  /** Populated for failures under --verbose, so a mismatch can be read at a glance. */
  actual?: { intent: string; slots: Record<string, unknown>; missing: string[] };
  /** Schema issue paths when the draft was rejected. Paths only, never values. */
  issues?: string[];
  /** The rejected draft, for --verbose. Eval fixtures only, so there is no real data in it. */
  rejected?: unknown;
  /** The provider's raw output, exactly as returned, for --record. */
  raw?: unknown;
};

// -- thresholds (PLAN §11.2) --------------------------------------------------

const THRESHOLDS = {
  noInventedSlots: 1.0, // hard gate
  missingSlotRecall: 1.0, // hard gate
  intentAccuracy: 0.97,
  exactSlotMatch: 0.95,
  offTopicAccuracy: 0.95,
  p95LatencyMs: 3000,
} as const;

// -- entry point --------------------------------------------------------------

type Recording = { provider: string; prompt: string; drafts: { id: string; draft: unknown }[] };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = sampleCases(loadCases(args.filter), args.sample);

  if (cases.length === 0) {
    fail('No eval cases matched. Check test/evals/cases.*.yaml.');
  }

  if (args.replay) {
    replay(args.replay, cases, args.verbose);
    return;
  }

  const provider = buildProvider(args);
  const results: CaseResult[] = [];

  process.stdout.write(
    `prompt ${PROMPT_VERSION} · provider ${provider.name} · ${cases.length} cases\n\n`,
  );

  // Groq's free tier caps BOTH requests per minute (30) and tokens per minute
  // (8,000) per model (PLAN §2). The token limit binds first: at ~1,000 prompt
  // tokens it allows only 8 requests a minute, and pacing by requests alone
  // makes the whole run collapse into rate-limit retries.
  //
  // So the pace is whichever limit is tighter, derived from the measured prompt
  // size rather than assumed. Editing the prompt automatically re-paces this.
  const promptTokens = args.provider === 'rules' ? 0 : estimateSize(cases[0]);
  const tokenPacedRpm = promptTokens > 0 ? Math.max(1, Math.floor(TOKENS_PER_MINUTE / promptTokens)) : args.rpm;
  const effectiveRpm = args.provider === 'rules' ? 0 : Math.min(args.rpm, tokenPacedRpm);

  if (promptTokens > 0) {
    const perRun = (cases.length * promptTokens) / 1000;
    process.stdout.write(
      `prompt ~${promptTokens} tokens · pacing ${effectiveRpm}/min · ` +
        `~${perRun.toFixed(0)}k tokens for this run of ${TOKENS_PER_DAY / 1000}k daily

`,
    );
  }

  const minIntervalMs = effectiveRpm > 0 ? Math.ceil(60_000 / effectiveRpm) : 0;
  let nextAllowedAt = 0;

  // A resume reads its own file back and skips what already has an answer. The
  // recording is the checkpoint, so there is nothing else to keep in step.
  const recordPath = args.resume ?? args.record;
  const alreadyAnswered = args.resume ? answeredDrafts(args.resume) : new Map<string, unknown>();
  if (alreadyAnswered.size > 0) {
    process.stdout.write(
      `resuming: ${alreadyAnswered.size} cases already answered, ${cases.length - alreadyAnswered.size} to go\n\n`,
    );
  }

  let patienceMs = args.waitMinutes * 60_000;

  for (const testCase of cases) {
    const recorded = alreadyAnswered.get(testCase.id);
    if (recorded !== undefined) {
      // Scored from the recording, exactly as --replay would. Marked `=` so the
      // progress line shows what was bought now and what was bought earlier.
      results.push(scoreRecorded(testCase, recorded));
      process.stdout.write('=');
      continue;
    }

    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    nextAllowedAt = Date.now() + minIntervalMs;

    let result: CaseResult | null = null;
    while (result === null) {
      try {
        result = await runCaseWithRetry(provider, testCase);
      } catch (error) {
        if (!(error instanceof DailyBudgetExhausted)) throw error;

        // The daily cap is a rolling window, so a wait of a few minutes buys
        // more of it. Sitting it out is only worth doing within a budget the
        // caller set: an eval that can hang for an hour is one nobody runs.
        const pauseMs = error.retryAfterSeconds * 1_000 + 5_000;
        if (pauseMs > patienceMs) {
          stopExhausted(error, results.length, cases.length, recordPath, args);
        }
        patienceMs -= pauseMs;
        process.stdout.write(
          `\n  token budget spent; waiting ${Math.ceil(pauseMs / 1_000)}s ` +
            `(${Math.round(patienceMs / 60_000)} min of patience left)\n  `,
        );
        await sleep(pauseMs);
      }
    }

    results.push(result);
    // Checkpoint every case. A run that stops at 27 of 156 should keep the 27 it
    // paid for, which is the whole difference between --resume working and not.
    if (recordPath) writeRecording(recordPath, provider.name, results);
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  if (recordPath) {
    const written = writeRecording(recordPath, provider.name, results);
    process.stdout.write(`recorded ${written} drafts to ${recordPath}\n\n`);
  }

  report(results, cases, provider.name, args.verbose);
}

/**
 * Stop, having said how to finish without re-buying what is already paid for.
 * Exits; the return type is for the caller's benefit.
 */
function stopExhausted(
  error: DailyBudgetExhausted,
  done: number,
  total: number,
  recordPath: string | null,
  args: { model: string },
): never {
  const minutes = Math.max(1, Math.round(error.retryAfterSeconds / 60));
  process.stdout.write(
    `\n\nStopped after ${done} of ${total} cases: the provider's token budget is\n` +
      `exhausted (retry-after ${minutes} min). The cap is a rolling window, not a\n` +
      `midnight reset, so waiting that long buys more of it.\n\n`,
  );
  if (recordPath) {
    process.stdout.write(
      `The ${done} answers so far are saved. Finish the rest with:\n` +
        `  pnpm eval --resume ${recordPath} --wait 90\n\n`,
    );
  } else {
    process.stdout.write(
      `Nothing was saved. Use --record <file> so a stopped run can be resumed.\n\n`,
    );
  }
  process.stdout.write(`Limits are per model; --model ${args.model} has its own.\n`);
  process.exit(2);
}

/** Cases in a recording that actually got an answer. A null draft did not. */
function answeredDrafts(path: string): Map<string, unknown> {
  const answered = new Map<string, unknown>();
  if (!existsSync(path)) return answered;

  const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  for (const { id, draft } of recording.drafts) {
    if (draft !== null && draft !== undefined) answered.set(id, draft);
  }
  return answered;
}

/** Write the checkpoint. Returns how many drafts it holds. */
function writeRecording(path: string, providerName: string, results: CaseResult[]): number {
  const recording: Recording = {
    provider: providerName,
    prompt: PROMPT_VERSION,
    // The provider's raw output, so a replay validates exactly what the live
    // run validated.
    drafts: results.map((r) => ({ id: r.id, draft: r.raw ?? null })),
  };
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(recording, null, 2), 'utf8');
  return recording.drafts.length;
}

/**
 * Score one case from a recorded draft.
 *
 * Shared by `--replay` and `--resume`, so a resumed run scores its earlier half
 * by exactly the same rules as its later one. `raw` is carried through, or the
 * next checkpoint would overwrite an answer with a null.
 */
function scoreRecorded(testCase: EvalCase, raw: unknown): CaseResult {
  const validated = raw === undefined || raw === null ? null : validateIntentDraft(raw);

  if (!validated || !validated.ok) {
    return {
      id: testCase.id,
      intentOk: false,
      slotsOk: false,
      missingOk: false,
      inventedSlots: [],
      latencyMs: 0,
      promptTokens: 0,
      cachedTokens: 0,
      // A case with no recorded draft never got an answer at all. Reporting
      // that as a schema rejection would blame the model for a dropped call.
      error: validated ? 'schema_invalid' : 'no_response',
      ...(validated && !validated.ok ? { issues: validated.issues, rejected: raw } : {}),
      ...(raw === undefined ? {} : { raw }),
    };
  }
  return { ...score(testCase, validated.draft), raw };
}

/**
 * A `retry-after` longer than this means the wait is a daily budget, not the
 * per-minute bucket. Retrying through it just burns time (PLAN §2).
 */
const DAILY_BUDGET_RETRY_AFTER_S = 60;

class DailyBudgetExhausted extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('daily_budget_exhausted');
  }
}

/**
 * A rate limit or a timeout says nothing about parse quality, so it is retried
 * rather than scored as a wrong answer.
 *
 * Latency is a separate question, and the plan has a separate threshold for it,
 * so the slowest attempt's latency is what gets reported. Retrying must not make
 * a slow provider look fast.
 */
const TRANSIENT = new Set(['rate_limited', 'timeout', 'provider_error', 'network_error']);

async function runCaseWithRetry(provider: NluProvider, testCase: EvalCase): Promise<CaseResult> {
  let worstLatency = 0;
  let last: CaseResult | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await runCase(provider, testCase);
    worstLatency = Math.max(worstLatency, result.latencyMs);
    last = result;

    if (!result.error || !TRANSIENT.has(result.error)) {
      return { ...result, latencyMs: worstLatency };
    }
    if ((result.retryAfterSeconds ?? 0) > DAILY_BUDGET_RETRY_AFTER_S) {
      throw new DailyBudgetExhausted(result.retryAfterSeconds!);
    }
    await sleep(1_500 * 2 ** attempt);
  }

  return { ...last!, latencyMs: worstLatency };
}

function estimateSize(sample: EvalCase | undefined): number {
  if (!sample) return 0;
  return estimatePromptTokens({
    text: sample.input,
    nowLocalIso: sample.now,
    weekday: 'Thursday',
    tools: toolCatalog(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCase(provider: NluProvider, testCase: EvalCase): Promise<CaseResult> {
  const now = new Date(testCase.now);
  const started = Date.now();

  const response = await provider.parse({
    text: testCase.input,
    nowLocalIso: testCase.now,
    weekday: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Jerusalem' }),
    tools: toolCatalog(),
  });

  const latencyMs = Date.now() - started;

  if (!response.ok) {
    return {
      id: testCase.id,
      intentOk: false,
      slotsOk: false,
      missingOk: false,
      inventedSlots: [],
      latencyMs,
      promptTokens: 0,
      cachedTokens: 0,
      error: response.error.code,
      ...(response.error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: response.error.retryAfterSeconds }
        : {}),
    };
  }

  const validated = validateIntentDraft(response.draft);
  if (!validated.ok) {
    return {
      id: testCase.id,
      intentOk: false,
      slotsOk: false,
      missingOk: false,
      inventedSlots: [],
      latencyMs,
      promptTokens: response.usage.promptTokens,
      cachedTokens: response.usage.cachedTokens,
      error: 'schema_invalid',
      issues: validated.issues,
      rejected: response.draft,
      raw: response.draft,
    };
  }

  return {
    ...score(testCase, validated.draft, latencyMs),
    promptTokens: response.usage.promptTokens,
    cachedTokens: response.usage.cachedTokens,
    raw: response.draft,
  };
}

export function score(testCase: EvalCase, draft: IntentDraft, latencyMs = 0): CaseResult {
  const expectedSlots = testCase.expect.slots ?? {};
  const expectedMissing = testCase.expect.missing ?? [];
  const actualSlots = draft.slots as Record<string, unknown>;

  const intentOk = draft.intent === testCase.expect.intent;

  // "Invented" means the model filled a slot the case says the user never
  // stated. That is the failure the whole design exists to prevent, so it is
  // counted separately from an ordinary slot mismatch.
  //
  // A slot that is present but absent from `expect.slots` is simply unchecked —
  // reminder text and event titles vary in wording, so cases pin only the slots
  // that must match exactly. Treating those as invented would make the gate
  // meaningless.
  const inventedSlots = Object.entries(actualSlots)
    .filter(([key, value]) => value !== undefined && expectedMissing.includes(key))
    .map(([key]) => key);

  // Date and time slots are compared by the instant they resolve to, not by
  // their JSON shape. "9 in the morning" is equally valid as meridiem "am" or
  // as part_of_day "morning", and both fire at 09:00 — scoring the encoding
  // instead of the outcome would fail correct answers and teach nothing.
  const timePairs: [string, string][] = [
    ['date', 'time'],
    ['from_date', 'from_time'],
    ['to_date', 'to_time'],
  ];
  const timeKeys = new Set(timePairs.flat());

  const structuralOk = Object.entries(expectedSlots)
    .filter(([key]) => !timeKeys.has(key))
    .every(([key, value]) => deepEqual(actualSlots[key], value));

  const temporalOk = timePairs.every(([dateKey, timeKey]) => {
    if (!(dateKey in expectedSlots) && !(timeKey in expectedSlots)) return true;
    return sameInstant(Date.parse(testCase.now), expectedSlots, actualSlots, dateKey, timeKey);
  });

  const slotsOk = intentOk && structuralOk && temporalOk;

  // Recall, not exact set equality: declaring an extra uncertainty is cautious,
  // failing to declare a real one is the dangerous direction.
  const missingOk = expectedMissing.every((slot) => draft.missing.includes(slot));

  return {
    id: testCase.id,
    intentOk,
    slotsOk,
    missingOk,
    inventedSlots,
    latencyMs,
    promptTokens: 0,
    cachedTokens: 0,
    actual: { intent: draft.intent, slots: actualSlots, missing: draft.missing },
  };
}

/** Re-score a recorded run. No network, no budget spent. */
function replay(path: string, cases: EvalCase[], verbose: boolean): void {
  const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  const byId = new Map(recording.drafts.map((d) => [d.id, d.draft]));
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    results.push(scoreRecorded(testCase, byId.get(testCase.id)));
  }

  process.stdout.write(
    `replay of ${path} · ${recording.provider} · prompt ${recording.prompt} · ${results.length} cases
` +
      `latency is not measured on a replay

`,
  );
  report(results, cases, `${recording.provider} (replay)`, verbose);
}

// -- reporting ----------------------------------------------------------------

function report(
  results: CaseResult[],
  cases: EvalCase[],
  providerName: string,
  verbose: boolean,
): void {
  const total = results.length;
  const offTopic = cases.filter((c) => c.expect.intent === 'unsupported').map((c) => c.id);
  const offTopicResults = results.filter((r) => offTopic.includes(r.id));

  const metrics = {
    noInventedSlots: ratio(results.filter((r) => r.inventedSlots.length === 0).length, total),
    missingSlotRecall: ratio(results.filter((r) => r.missingOk).length, total),
    intentAccuracy: ratio(results.filter((r) => r.intentOk).length, total),
    exactSlotMatch: ratio(results.filter((r) => r.slotsOk).length, total),
    offTopicAccuracy: offTopicResults.length
      ? ratio(offTopicResults.filter((r) => r.intentOk).length, offTopicResults.length)
      : 1,
    p95LatencyMs: percentile(results.map((r) => r.latencyMs), 0.95),
  };

  const rows: [string, number, number, boolean][] = [
    ['no invented slots', metrics.noInventedSlots, THRESHOLDS.noInventedSlots, metrics.noInventedSlots >= THRESHOLDS.noInventedSlots],
    ['missing-slot recall', metrics.missingSlotRecall, THRESHOLDS.missingSlotRecall, metrics.missingSlotRecall >= THRESHOLDS.missingSlotRecall],
    ['intent accuracy', metrics.intentAccuracy, THRESHOLDS.intentAccuracy, metrics.intentAccuracy >= THRESHOLDS.intentAccuracy],
    ['exact slot match', metrics.exactSlotMatch, THRESHOLDS.exactSlotMatch, metrics.exactSlotMatch >= THRESHOLDS.exactSlotMatch],
    ['off-topic -> unsupported', metrics.offTopicAccuracy, THRESHOLDS.offTopicAccuracy, metrics.offTopicAccuracy >= THRESHOLDS.offTopicAccuracy],
  ];

  for (const [label, value, threshold, pass] of rows) {
    process.stdout.write(
      `${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} ${pct(value)}  (threshold ${pct(threshold)})\n`,
    );
  }

  const billedPrompt = results.reduce((sum, r) => sum + r.promptTokens, 0);
  const cached = results.reduce((sum, r) => sum + r.cachedTokens, 0);
  if (billedPrompt > 0) {
    const share = ((cached / billedPrompt) * 100).toFixed(0);
    process.stdout.write(
      `      ${'prompt tokens'.padEnd(26)} ${billedPrompt} total, ${cached} cached (${share}%)
`,
    );
  }

  const latencyPass = metrics.p95LatencyMs < THRESHOLDS.p95LatencyMs;
  process.stdout.write(
    `${latencyPass ? 'PASS' : 'FAIL'}  ${'p95 latency'.padEnd(26)} ${metrics.p95LatencyMs} ms  (threshold ${THRESHOLDS.p95LatencyMs} ms)\n`,
  );

  const failures = results.filter((r) => !r.intentOk || !r.slotsOk || !r.missingOk || r.inventedSlots.length > 0);
  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failing case(s):\n`);
    for (const f of failures.slice(0, 30)) {
      const reasons = [
        !f.intentOk && 'intent',
        !f.slotsOk && 'slots',
        !f.missingOk && 'missing',
        f.inventedSlots.length > 0 && `invented:${f.inventedSlots.join('/')}`,
        f.error,
      ].filter(Boolean);
      process.stdout.write(`  ${f.id}  ${reasons.join(' ')}\n`);
      if (verbose && f.actual) {
        const expected = cases.find((c) => c.id === f.id)?.expect;
        process.stdout.write(`      expected ${JSON.stringify(expected)}\n`);
        process.stdout.write(`      actual   ${JSON.stringify(f.actual)}\n`);
      }
    }
  }

  const allPass = rows.every(([, , , pass]) => pass) && latencyPass;
  process.stdout.write(
    `\n${allPass ? 'All thresholds met' : 'Thresholds NOT met'} — provider ${providerName}, prompt ${PROMPT_VERSION}\n`,
  );
  process.exit(allPass ? 0 : 1);
}

// -- helpers ------------------------------------------------------------------

function buildProvider(args: { provider: string; model: string }): NluProvider {
  if (args.provider === 'rules') return createRulesProvider();

  loadDevVars();
  const apiKey = process.env['GROQ_API_KEY'] ?? '';
  if (!apiKey) {
    fail(
      'GROQ_API_KEY is not set.\n' +
        'Put it in .dev.vars (git-ignored), or run with --provider rules.',
    );
  }
  return createGroqProvider({ apiKey, model: args.model });
}

/**
 * Read staging values from `.dev.vars` into this process only.
 *
 * The file is never printed, echoed, or written back, and an already-set
 * environment variable wins so CI can inject its own. Real secrets belong in
 * Wrangler secrets; this file holds staging values only (PLAN §7.2).
 */
function loadDevVars(): void {
  const path = fileURLToPath(new URL('../../.dev.vars', import.meta.url));
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    process.env[key] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
}

/**
 * Take an even slice across categories rather than the first N cases.
 *
 * The daily token budget allows roughly one full run per model (PLAN §2), so
 * iterating on the prompt has to work from a sample. A sample that is not
 * stratified would be worse than useless here: the file is grouped by category,
 * so the first 30 cases are all Hebrew reminders and would report nothing about
 * injection handling or calendar writes.
 *
 * Case ids carry their category — `he-rem-001`, `en-inj-004` — so the prefix is
 * the stratum.
 */
export function sampleCases(cases: EvalCase[], size: number | null): EvalCase[] {
  if (!size || size >= cases.length) return cases;

  const byCategory = new Map<string, EvalCase[]>();
  for (const testCase of cases) {
    const category = testCase.id.replace(/-\d+$/, '');
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(testCase);
    else byCategory.set(category, [testCase]);
  }

  // Round-robin across categories until the sample is full, so every category
  // is represented before any is represented twice.
  const buckets = [...byCategory.values()];
  const picked: EvalCase[] = [];
  for (let round = 0; picked.length < size; round++) {
    let tookAny = false;
    for (const bucket of buckets) {
      const next = bucket[round];
      if (!next) continue;
      picked.push(next);
      tookAny = true;
      if (picked.length === size) break;
    }
    if (!tookAny) break;
  }

  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

function loadCases(filter: string | null): EvalCase[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const cases: EvalCase[] = [];

  for (const file of ['cases.he.yaml', 'cases.en.yaml']) {
    const path = `${dir}${file}`;
    if (!existsSync(path)) continue;
    const parsed = parseYaml(readFileSync(path, 'utf8')) as EvalCase[] | null;
    if (Array.isArray(parsed)) cases.push(...parsed);
  }

  return filter ? cases.filter((c) => c.id.includes(filter)) : cases;
}

function parseArgs(argv: string[]): {
  model: string;
  provider: string;
  filter: string | null;
  rpm: number;
  verbose: boolean;
  record: string | null;
  replay: string | null;
  resume: string | null;
  waitMinutes: number;
  sample: number | null;
} {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const provider = get('--provider') ?? 'groq';
  const rpm = Number(get('--rpm') ?? (provider === 'rules' ? 0 : 25));
  return {
    model: get('--model') ?? DEFAULT_MODEL,
    provider,
    filter: get('--filter'),
    // Default 25, comfortably under the free tier's 30 RPM.
    rpm: Number.isFinite(rpm) && rpm >= 0 ? rpm : 25,
    verbose: argv.includes('--verbose'),
    record: get('--record'),
    replay: get('--replay'),
    resume: get('--resume'),
    // Total patience for daily-budget waits, across the whole run. Zero keeps
    // the old behaviour: stop and print how to resume.
    waitMinutes: Number(get('--wait') ?? 0) || 0,
    sample: get('--sample') ? Number(get('--sample')) : null,
  };
}

/**
 * Compare a date/time slot pair by what it resolves to, not by its JSON shape.
 *
 * Only what the case actually pins is compared. A case that pins `date` alone
 * is asserting the day, not that the model must find no time — so the day is
 * compared and the hour is left alone. Asserting more than the case states
 * would fail correct answers for a reason nobody wrote down.
 */
const NEUTRAL_TIME: TimeSpec = {
  hour: 12,
  minute: 0,
  meridiem: 'unspecified',
  part_of_day: 'unspecified',
};

function sameInstant(
  nowMs: number,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  dateKey: string,
  timeKey: string,
): boolean {
  const pinsTime = timeKey in expected;
  const pinsDate = dateKey in expected;

  const resolve = (slots: Record<string, unknown>, useNeutralTime: boolean) =>
    resolveWhen(
      {
        date: slots[dateKey] as DateSpec | undefined,
        // A duration already carries its own time; forcing one on it would
        // change what is being compared.
        ...(useNeutralTime && (slots[dateKey] as DateSpec | undefined)?.kind !== 'in_duration'
          ? { time: NEUTRAL_TIME }
          : { time: slots[timeKey] as TimeSpec | undefined }),
      },
      { nowMs },
    );

  // Time only: the case asserts the hour, not the day. Both sides are resolved
  // against the same future date so that "already past" cannot fire on one side
  // and not the other and turn a matching hour into a mismatch.
  if (pinsTime && !pinsDate) {
    const onNeutralDay = (slots: Record<string, unknown>) =>
      resolveWhen(
        {
          date: { kind: 'relative_days', offset: 1 },
          time: slots[timeKey] as TimeSpec | undefined,
        },
        { nowMs },
      );
    const et = onNeutralDay(expected);
    const at = onNeutralDay(actual);
    if (et.kind === 'resolved' && at.kind === 'resolved') {
      return et.local.hour === at.local.hour && et.local.minute === at.local.minute;
    }
    return et.kind === at.kind;
  }

  // Day only: compare the calendar date, with the same neutral hour on both sides.
  const useNeutral = pinsDate && !pinsTime;
  const e = resolve(expected, useNeutral);
  const a = resolve(actual, useNeutral);

  if (e.kind === 'resolved' && a.kind === 'resolved') {
    return useNeutral
      ? e.local.year === a.local.year && e.local.month === a.local.month && e.local.day === a.local.day
      : e.utcMs === a.utcMs;
  }
  // Both refusing for the same reason is agreement too: the case asserts this
  // input is not resolvable, and the model produced something that also is not.
  if (e.kind === 'clarify' && a.kind === 'clarify') return e.rule === a.rule;
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function ratio(hit: number, total: number): number {
  return total === 0 ? 1 : hit / total;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Run only when invoked as a script. The scoring and sampling helpers are
// imported by unit tests, which must not start an eval run.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) await main();
