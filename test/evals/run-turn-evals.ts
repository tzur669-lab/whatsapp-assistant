/**
 * Whole agent turns, OLD vs NEW, against the real provider (PLAN §9, 2026-10-06).
 *
 * `pnpm eval:agent` scores a model's first call. This runs complete turns
 * through the real pipeline — selection, text-only calls, the reads that
 * answer, the writes and confirmations — with the fakes from
 * `test/integration/` for everything but the model, and compares two configs on
 * the same cases, the same model and the same request parameters:
 *
 * - OLD: the full catalog on every call (before 2026-10-06);
 * - NEW: tools selected by code, and text-only calls after a read.
 *
 * Representative, not statistical. Every message is synthetic.
 *
 * Fairness and quota:
 * - pairs run alternating (OLD then NEW, then NEW then OLD), spaced like the evals;
 * - a rate or budget refusal is "not run", never a pass or a fail: the run
 *   waits out the `retry-after` and re-queues the case at most twice;
 * - a failed case runs once more and fails only if both runs fail;
 * - every request is charged to the shared daily ledger before it is sent, and
 *   the run stops itself at the ledger's guard; `--resume` goes on another day.
 *
 * Acceptance (the one rule): NEW is accepted iff, over complete pairs,
 *   1. no case that passes on OLD fails on NEW;
 *   2. zero writes in cases that expect none;
 *   3. wrong-tool count NEW ≤ OLD;
 *   4. the median tokens per turn, over cases passing in both, drop by ≥ 30%;
 *   5. no single case costs more than 1.25× its OLD tokens;
 *   6. the failover integration tests are green (`pnpm test`).
 *
 * Usage: tsx test/evals/run-turn-evals.ts [--model <id>] [--filter turn-read] [--resume] [--report]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository } from '../../src/core/repo.js';
import { handleInbound } from '../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../src/core/pipeline.js';
import { ReminderStore } from '../../src/tools/reminder-store.js';
import { NoteStore } from '../../src/tools/note-store.js';
import { ExpenseStore } from '../../src/tools/expense-store.js';
import { PendingActions } from '../../src/confirm/pending.js';
import { UndoActions } from '../../src/confirm/undo.js';
import { OpenQuestions } from '../../src/confirm/questions.js';
import { MIGRATIONS } from '../../src/platform/migrations.js';
import { parseKeyring } from '../../src/security/crypto.js';
import { CHARS_PER_TOKEN, TokenBudget } from '../../src/agent/budget.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { AgentLock } from '../../src/agent/lock.js';
import { DEFAULT_MAX_COMPLETION_TOKENS, modelEntry, QWEN } from '../../src/agent/models.js';
import { createGroqAgentProvider } from '../../src/agent/provider.js';
import type { AgentProvider, AgentResponse } from '../../src/agent/provider.js';
import { promptChars } from '../../src/agent/loop.js';
import { fromWireName } from '../../src/agent/tools.js';
import { REGISTRY, TOOL_NAMES } from '../../src/tools/registry.js';
import type { ToolName } from '../../src/tools/registry.js';
import type { CalendarClient, CalendarEvent } from '../../src/google/calendar.js';
import type { InboundEvent } from '../../src/channels/types.js';
import { TestSqlDriver } from '../integration/sqlite-driver.js';
import { createFakeLogger } from '../integration/fake-logger.js';
import { createFakeNlu, draft } from '../integration/fake-nlu.js';
import { spacingMs } from './run-evals.js';
import { EvalLedger } from './ledger.js';

type Config = 'OLD' | 'NEW';
type Category =
  | 'read'
  | 'read+word'
  | 'write'
  | 'write-missing'
  | 'ambiguous'
  | 'natural'
  | 'follow-up'
  | 'discriminating'
  | 'breadth';

type TurnCase = {
  id: string;
  category: Category;
  input: string;
  /** A message before this one, in the same conversation (follow-ups). */
  before?: string;
  /** The tools a correct turn may call first; `text` for an answer in words. */
  expect: Array<ToolName | 'text'>;
  /** Whether a write is right for this message. */
  write: boolean;
};

/** Thursday 2026-09-24, 12:00 local, as in the corpus. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_turn_eval';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const CASES: TurnCase[] = [
  { id: 'turn-read-001', category: 'read', input: 'מה התזכורות שלי?', expect: ['reminders.list'], write: false },
  { id: 'turn-read-002', category: 'read', input: 'מה הפתקים ששמרתי?', expect: ['notes.find'], write: false },
  { id: 'turn-read-003', category: 'read', input: 'כמה הוצאתי החודש?', expect: ['expenses.summary'], write: false },
  { id: 'turn-word-001', category: 'read+word', input: 'מה יש לי ביומן היום?', expect: ['calendar.list_events'], write: false },
  { id: 'turn-word-002', category: 'read+word', input: 'יש לי זמן פנוי היום אחרי הצהריים?', expect: ['calendar.free_time', 'calendar.list_events'], write: false },
  { id: 'turn-word-003', category: 'read+word', input: 'what is on my calendar today?', expect: ['calendar.list_events'], write: false },
  { id: 'turn-write-001', category: 'write', input: 'תזכיר לי מחר בשמונה בערב להוציא את הזבל', expect: ['reminders.create'], write: true },
  { id: 'turn-write-002', category: 'write', input: 'הוצאתי 40 שקל על קפה', expect: ['expenses.add'], write: true },
  { id: 'turn-write-003', category: 'write', input: 'תרשום לי פתק: הקוד של הלוקר בצד שמאל', expect: ['notes.save'], write: true },
  { id: 'turn-write-004', category: 'write', input: 'remind me tomorrow at 9 to pay rent', expect: ['reminders.create'], write: true },
  { id: 'turn-miss-001', category: 'write-missing', input: 'תזכיר לי מחר להתקשר לרופא', expect: ['reminders.create', 'text'], write: true },
  { id: 'turn-miss-002', category: 'write-missing', input: 'תקבע לי פגישה עם רונית', expect: ['calendar.create_event', 'text'], write: true },
  { id: 'turn-miss-003', category: 'write-missing', input: 'תזכיר לי לקנות חלב', expect: ['reminders.create', 'text'], write: true },
  { id: 'turn-amb-001', category: 'ambiguous', input: 'תבטל את זה', expect: ['text', 'reminders.list'], write: false },
  { id: 'turn-amb-002', category: 'ambiguous', input: 'תזיז את זה לארבע', expect: ['text', 'reminders.list', 'calendar.list_events'], write: false },
  { id: 'turn-amb-003', category: 'ambiguous', input: 'כן', expect: ['text'], write: false },
  { id: 'turn-nat-001', category: 'natural', input: 'אל תיתן לי לשכוח את יום ההולדת של נועה ביום שלישי בעשר', expect: ['reminders.create'], write: true },
  { id: 'turn-nat-002', category: 'natural', input: 'עלה לי 35 הסנדוויץ׳', expect: ['expenses.add'], write: true },
  { id: 'turn-nat-003', category: 'natural', input: 'מה אני עושה מחר בערב?', expect: ['calendar.list_events'], write: false },
  { id: 'turn-fol-001', category: 'follow-up', before: 'מה יש לי ביומן מחר?', input: 'ותזכיר לי חצי שעה לפני', expect: ['reminders.create', 'text'], write: true },
  { id: 'turn-fol-002', category: 'follow-up', before: 'הוצאתי 50 על דלק', input: 'ועוד 20 על חניה', expect: ['expenses.add'], write: true },
  { id: 'turn-fol-003', category: 'follow-up', before: 'מה התזכורות שלי?', input: 'תודה', expect: ['text'], write: false },
  { id: 'turn-dis-001', category: 'discriminating', input: 'תזכיר לי מה כתבתי על דני', expect: ['notes.find'], write: false },
  { id: 'turn-dis-002', category: 'discriminating', input: 'תזכור שהחניה בקומה מינוס שתיים', expect: ['notes.save'], write: true },
  { id: 'turn-dis-003', category: 'discriminating', input: 'מה רשמתי על הפגישה עם המשקיעים?', expect: ['notes.find'], write: false },
  { id: 'turn-dis-004', category: 'discriminating', input: 'כמה עלה לי החשמל בחודש שעבר?', expect: ['expenses.summary'], write: false },
  { id: 'turn-dis-005', category: 'discriminating', input: 'כמה זה 15% מ-240?', expect: ['calc.compute', 'text'], write: false },
  { id: 'turn-brd-001', category: 'breadth', input: 'תזכיר לי מחר להתקשר לאמא בשמונה', expect: ['reminders.create'], write: true },
  { id: 'turn-brd-002', category: 'breadth', input: 'תבדוק אם יש לי זמן מחר ותזכיר לי לקבוע תור', expect: ['calendar.free_time', 'calendar.list_events', 'reminders.create', 'text'], write: true },
  { id: 'turn-brd-003', category: 'breadth', input: 'כמה זמן מבשלים אורז מלא?', expect: ['text'], write: false },
];

type Run = {
  status: 'ok' | 'not_run';
  pass: boolean;
  firstTool: ToolName | 'text' | null;
  wrongTool: boolean;
  unexpectedWrite: boolean;
  calls: number;
  tokens: number;
  narrowed: boolean;
  /** Calibration (§2): characters the estimator divides, and what the provider counted, per call. */
  calibration: Array<{ chars: number; promptTokens: number }>;
};

type Recording = { model: string; runs: Record<string, Run> };

const isWrite = (tool: ToolName) => REGISTRY[tool].tier > 0;

function fakeCalendar(): CalendarClient {
  const at = (iso: string, title: string): CalendarEvent => {
    const start = Date.parse(iso);
    return { id: `evt-${start}`, title, startUtc: start, endUtc: start + 3_600_000, allDay: false, createdByAssistant: false, etag: null };
  };
  const events = [at('2026-09-24T11:00:00Z', 'פגישת צוות'), at('2026-09-25T15:00:00Z', 'ארוחת ערב')];
  return {
    listAllEvents(...args: unknown[]) {
      return (this as unknown as { listEvents: (...a: unknown[]) => unknown }).listEvents(...args);
    },
    async listEvents() {
      return { ok: true as const, value: events };
    },
  } as unknown as CalendarClient;
}

/** One case, one config, through the real pipeline. */
async function runCase(testCase: TurnCase, config: Config, model: string, apiKey: string, ledger: EvalLedger): Promise<Run> {
  const driver = new TestSqlDriver();
  try {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    const reminders = new ReminderStore(driver, () => NOW);
    const notes = new NoteStore(driver, () => NOW);
    const expenses = new ExpenseStore(driver, () => NOW);
    notes.add(PRINCIPAL, 'דני ביקש את המצגת עד יום ראשון');
    const budget = new TokenBudget(Date.now);
    const entry = modelEntry(model);
    const real = createGroqAgentProvider({
      apiKey,
      model,
      role: 'primary',
      timeoutMs: 30_000,
      ...(entry ? { maxCompletionTokens: entry.maxCompletionTokens, params: entry.params } : {}),
    });

    const seen: Run = { status: 'ok', pass: false, firstTool: null, wrongTool: false, unexpectedWrite: false, calls: 0, tokens: 0, narrowed: false, calibration: [] };
    let rateLimited = false;
    let measuring = false;
    const provider: AgentProvider = {
      model,
      role: 'primary',
      maxCompletionTokens: real.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      async complete(messages, tools): Promise<AgentResponse> {
        const chars = promptChars(messages, JSON.stringify(tools).length);
        const charge = ledger.begin(model, Math.ceil(chars / CHARS_PER_TOKEN) + (real.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS));
        const response = await real.complete(messages, tools);
        if (!response.ok) {
          ledger.settle(charge, 0);
          if (response.error.code === 'rate_limited') rateLimited = true;
          return response;
        }
        const used = response.usage.promptTokens + response.usage.completionTokens;
        ledger.settle(charge, used);
        if (!measuring) return response;
        seen.calls += 1;
        seen.tokens += used;
        seen.calibration.push({ chars, promptTokens: response.usage.promptTokens });
        if (seen.calls === 1) seen.narrowed = tools.length < 30;
        const offered = tools.map((tool) => tool.function.name).map((wire) => fromWireName(wire, TOOL_NAMES)).filter((t): t is ToolName => t !== null);
        const called = response.toolCalls[0] ? fromWireName(response.toolCalls[0].name, offered) : null;
        if (seen.firstTool === null) seen.firstTool = called ?? 'text';
        if (called && isWrite(called) && !testCase.write) seen.unexpectedWrite = true;
        return response;
      },
    };

    const services: Services = {
      reminders,
      notes,
      expenses,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      calendar: fakeCalendar(),
      agent: {
        providers: [provider],
        budget,
        history: new ConversationHistory(driver, () => NOW, keyring),
        lock: new AgentLock(driver, () => NOW),
        ...(config === 'OLD' ? { legacyCatalog: true } : {}),
      },
    };
    const deps: PipelineDeps = {
      repo,
      log: createFakeLogger(),
      now: () => NOW,
      principal: PRINCIPAL,
      services,
      channel: 'app',
    };

    let seq = 0;
    const message = (body: string): InboundEvent =>
      ({ kind: 'text', wamid: `wamid.turn.${testCase.id}.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

    if (testCase.before) await handleInbound(message(testCase.before), deps);
    measuring = true;
    await handleInbound(message(testCase.input), deps);

    if (rateLimited) return { ...seen, status: 'not_run' };
    const first = seen.firstTool ?? 'text';
    seen.wrongTool = first !== 'text' && !testCase.expect.includes(first);
    seen.pass = testCase.expect.includes(first) && !seen.unexpectedWrite;
    return seen;
  } finally {
    driver.close();
  }
}

async function main(): Promise<void> {
  loadDevVars();
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env['GROQ_API_KEY'] ?? '';
  const path = recordingPath(args.model);
  const recording: Recording =
    args.resume && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Recording) : { model: args.model, runs: {} };
  const cases = args.filter ? CASES.filter((c) => c.id.includes(args.filter!)) : CASES;

  if (!args.report) {
    if (!apiKey) fail('GROQ_API_KEY is not set. Put it in .dev.vars (git-ignored).');
    const ledger = EvalLedger.open(fileURLToPath(new URL('./recordings/', import.meta.url)));
    try {
      let costliest = 0;
      outer: for (const [index, testCase] of cases.entries()) {
        const order: Config[] = index % 2 === 0 ? ['OLD', 'NEW'] : ['NEW', 'OLD'];
        for (const config of order) {
          const key = `${testCase.id}:${config}`;
          if (recording.runs[key]?.status === 'ok') continue;
          let run: Run | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const stop = ledger.stopReason(args.model);
            if (stop) {
              out(`\nStopped: ${stop}. Run again with --resume tomorrow.`);
              break outer;
            }
            run = await runCase(testCase, config, args.model, apiKey, ledger);
            if (run.status === 'ok' && !run.pass) {
              // Once more: a case fails only if both runs fail.
              const again = await runCase(testCase, config, args.model, apiKey, ledger);
              if (again.status === 'ok' && again.pass) run = again;
            }
            if (run.status === 'ok') break;
            out(`  ${key} rate-limited; waiting a minute (attempt ${attempt + 1} of 3)`);
            await sleep(60_000);
          }
          if (!run) continue;
          recording.runs[key] = run;
          save(path, recording);
          out(`  ${key.padEnd(22)} ${run.status === 'ok' ? (run.pass ? 'pass' : 'FAIL') : 'not run'}  ${run.firstTool ?? '-'}  ${run.tokens} tok  ${run.calls} calls${run.narrowed ? '  narrowed' : ''}`);
          costliest = Math.max(costliest, run.tokens);
          await sleep(spacingMs(costliest, 8_000, 60_000));
        }
      }
    } finally {
      ledger.close();
    }
  }
  report(cases, recording);
}

function report(cases: TurnCase[], recording: Recording): void {
  const pairs = cases
    .map((c) => ({ c, old: recording.runs[`${c.id}:OLD`], neu: recording.runs[`${c.id}:NEW`] }))
    .filter((p): p is { c: TurnCase; old: Run; neu: Run } => p.old?.status === 'ok' && p.neu?.status === 'ok');
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
  };

  out(`\n== ${recording.model}: ${pairs.length}/${cases.length} complete pairs`);
  const categories = [...new Set(cases.map((c) => c.category))];
  out('category          OLD pass  NEW pass  OLD med tok  NEW med tok');
  for (const category of categories) {
    const inCat = pairs.filter((p) => p.c.category === category);
    out(
      `${category.padEnd(18)}${String(inCat.filter((p) => p.old.pass).length).padStart(8)}${String(inCat.filter((p) => p.neu.pass).length).padStart(10)}` +
        `${String(median(inCat.map((p) => p.old.tokens))).padStart(13)}${String(median(inCat.map((p) => p.neu.tokens))).padStart(13)}`,
    );
  }

  const regressions = pairs.filter((p) => p.old.pass && !p.neu.pass).map((p) => p.c.id);
  const unexpectedWrites = pairs.filter((p) => p.neu.unexpectedWrite).map((p) => p.c.id);
  const wrongOld = pairs.filter((p) => p.old.wrongTool).length;
  const wrongNew = pairs.filter((p) => p.neu.wrongTool).length;
  const both = pairs.filter((p) => p.old.pass && p.neu.pass);
  const oldMedian = median(both.map((p) => p.old.tokens));
  const newMedian = median(both.map((p) => p.neu.tokens));
  const drop = oldMedian === 0 ? 0 : 1 - newMedian / oldMedian;
  const costly = pairs.filter((p) => p.old.tokens > 0 && p.neu.tokens > p.old.tokens * 1.25).map((p) => p.c.id);
  const narrowed = pairs.filter((p) => p.neu.narrowed).length;

  const mark = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  out(`\nnarrowing rate          ${((narrowed / Math.max(1, pairs.length)) * 100).toFixed(0)}%   full-catalog rate ${(((pairs.length - narrowed) / Math.max(1, pairs.length)) * 100).toFixed(0)}%`);
  out(`calls per turn          OLD ${(pairs.reduce((a, p) => a + p.old.calls, 0) / Math.max(1, pairs.length)).toFixed(2)}  NEW ${(pairs.reduce((a, p) => a + p.neu.calls, 0) / Math.max(1, pairs.length)).toFixed(2)}`);
  out(`1. no OLD-pass → NEW-fail   ${mark(regressions.length === 0)}${regressions.length ? `  (${regressions.join(', ')})` : ''}`);
  out(`2. no unexpected writes     ${mark(unexpectedWrites.length === 0)}${unexpectedWrites.length ? `  (${unexpectedWrites.join(', ')})` : ''}`);
  out(`3. wrong tool NEW ≤ OLD      ${mark(wrongNew <= wrongOld)}  (OLD ${wrongOld}, NEW ${wrongNew})`);
  out(`4. median tokens −≥30%      ${mark(drop >= 0.3)}  (OLD ${oldMedian}, NEW ${newMedian}, −${(drop * 100).toFixed(0)}%)`);
  out(`5. no case > 1.25× OLD      ${mark(costly.length === 0)}${costly.length ? `  (${costly.join(', ')})` : ''}`);
  out('6. failover integration tests: run `pnpm test`');
  const incomplete = cases.length - pairs.length;
  if (incomplete > 0) out(`\n${incomplete} case(s) without a complete pair: not judged. Run again with --resume.`);
}

// -- plumbing -----------------------------------------------------------------

function recordingPath(model: string): string {
  const dir = fileURLToPath(new URL('./recordings/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  return `${dir}turns-${model.replace(/[^a-z0-9.-]+/gi, '_')}.json`;
}

function save(path: string, recording: Recording): void {
  writeFileSync(path, JSON.stringify(recording, null, 1));
}

function parseArgs(argv: string[]): { model: string; filter: string | null; resume: boolean; report: boolean } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  return {
    model: value('--model') ?? QWEN,
    filter: value('--filter'),
    resume: argv.includes('--resume') || argv.includes('--report'),
    report: argv.includes('--report'),
  };
}

/** Staging values into this process only; never printed (PLAN §7.2). */
function loadDevVars(): void {
  const path = fileURLToPath(new URL('../../.dev.vars', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) await main();
