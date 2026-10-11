/**
 * Routines, stage 2 (PLAN §6.27): the store's one-way run lifecycle, the
 * `routine.run` tool, and the turn that offers it only when a routine is named.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import {
  RoutineStore,
  ROUTINE_MAX_LATE_MS,
  ROUTINE_NOTICE_MS,
  ROUTINE_REPUSH_MS,
  ROUTINE_STALE_CLAIM_MS,
} from '../../../src/tools/routine-store.js';
import type { RoutineName } from '../../../src/tools/routine-store.js';
import { findRoutine, routineRun } from '../../../src/tools/routines.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { decide, DEFAULT_LIMITS } from '../../../src/policy/engine.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { selectTools } from '../../../src/agent/tool-groups.js';
import { handleInbound, namesRoutine } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { parseRoutineClaim, parseRoutineResult, parseRoutineSync } from '../../../src/channels/app/parse.js';
import { APP_ROUTES } from '../../../src/channels/app/ingress.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-11T07:00:00Z'); // Sunday 10:00 in Israel
const PRINCIPAL = 'p_routines';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const plain = (text: string) => stripIsolates(text);

const EXIT: RoutineName = { routineId: '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f', name: 'יציאה מהעבודה', stepHash: HASH_A, appLabel: 'clock2go2020' };
const ENTRY: RoutineName = { routineId: '29a0b383-41e9-46c8-8573-6dd5f550b2f0', name: 'כניסה', stepHash: HASH_B, appLabel: 'clock2go2020' };

describe('the run lifecycle', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let store: RoutineStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    store = new RoutineStore(driver, () => clock);
    store.replaceNames(PRINCIPAL, [EXIT, ENTRY]);
  });
  afterEach(() => driver.close());

  const schedule = (dueAtUtc: number) => store.schedule({ principal: PRINCIPAL, routine: EXIT, dueAtUtc, tz: 'Asia/Jerusalem' }).run;

  it('notices two minutes before, pushes at the time, and is claimed exactly once', () => {
    const run = schedule(NOW + 15 * 60_000);
    expect(store.takeNotices(NOW)).toEqual([]);
    const notices = store.takeNotices(run.dueAtUtc - ROUTINE_NOTICE_MS);
    expect(notices.map((n) => n.run.runId)).toEqual([run.runId]);
    expect(notices[0]!.nonce).toMatch(/^[0-9a-f]{32}$/);
    // Re-entered: nothing twice.
    expect(store.takeNotices(run.dueAtUtc - ROUTINE_NOTICE_MS)).toEqual([]);

    clock = run.dueAtUtc;
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'already' }); // not pushed yet
    expect(store.takeDue(clock).push.map((r) => r.runId)).toEqual([run.runId]);
    expect(store.takeDue(clock).push).toEqual([]);

    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: true, routineId: EXIT.routineId, stepHash: HASH_A });
    // A second push, a restart, FCM delivering twice: refused.
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'already' });
    expect(store.claim(run.runId, 'someone_else')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('settles once; a duplicate result changes nothing', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    store.claim(run.runId, PRINCIPAL);
    expect(store.settle(run.runId, PRINCIPAL, 'verified', null)?.status).toBe('done');
    expect(store.settle(run.runId, PRINCIPAL, 'verified', null)).toBeNull();
    expect(store.get(run.runId)?.status).toBe('done');
  });

  it('a failure after a tap is "unknown", never "failed": something may have happened', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    store.claim(run.runId, PRINCIPAL);
    expect(store.settle(run.runId, PRINCIPAL, 'failed_after_tap', 'not_verified')?.status).toBe('unknown');
  });

  it('never runs late: a held run expires instead of being pushed', () => {
    const run = schedule(NOW);
    const due = store.takeDue(NOW + ROUTINE_MAX_LATE_MS + 1);
    expect(due.push).toEqual([]);
    expect(due.expired.map((r) => r.runId)).toEqual([run.runId]);
  });

  it('re-pushes an unclaimed run once a minute, and expires it after ten', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    expect(store.takeUnclaimed(NOW + 30_000).repush).toEqual([]);
    expect(store.takeUnclaimed(NOW + ROUTINE_REPUSH_MS).repush.map((r) => r.runId)).toEqual([run.runId]);
    const late = store.takeUnclaimed(NOW + ROUTINE_MAX_LATE_MS + 1);
    expect(late.expired.map((r) => r.runId)).toEqual([run.runId]);
    clock = NOW + ROUTINE_MAX_LATE_MS + 2;
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'late' });
  });

  it('a claim on time but after the window is refused even before the sweep', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    clock = NOW + ROUTINE_MAX_LATE_MS + 1;
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'late' });
  });

  it('cancels with the notice nonce only, and not once the phone claimed it', () => {
    const run = schedule(NOW + ROUTINE_NOTICE_MS);
    const [notice] = store.takeNotices(NOW);
    expect(store.cancel(run.runId, 'f'.repeat(32), PRINCIPAL)).toBe('gone');
    expect(store.cancel(run.runId, notice!.nonce, PRINCIPAL)).toBe('cancelled');
    expect(store.takeDue(run.dueAtUtc).push).toEqual([]);

    const other = schedule(NOW + ROUTINE_NOTICE_MS);
    const [second] = store.takeNotices(NOW);
    clock = other.dueAtUtc;
    store.takeDue(clock);
    store.claim(other.runId, PRINCIPAL);
    expect(store.cancel(other.runId, second!.nonce, PRINCIPAL)).toBe('started');
  });

  it('a pushed run cancelled before the claim is refused at the claim', () => {
    const run = schedule(NOW + ROUTINE_NOTICE_MS);
    const [notice] = store.takeNotices(NOW);
    clock = run.dueAtUtc;
    store.takeDue(clock);
    expect(store.cancel(run.runId, notice!.nonce, PRINCIPAL)).toBe('cancelled');
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('an edited or deleted routine closes its waiting runs at sync time', () => {
    const run = schedule(NOW + 60 * 60_000);
    const closed = store.replaceNames(PRINCIPAL, [{ ...EXIT, stepHash: HASH_B }, ENTRY]);
    expect(closed.map((r) => r.runId)).toEqual([run.runId]);
    expect(store.get(run.runId)?.status).toBe('changed');

    const again = store.schedule({ principal: PRINCIPAL, routine: ENTRY, dueAtUtc: NOW + 60 * 60_000, tz: 'Asia/Jerusalem' }).run;
    expect(store.replaceNames(PRINCIPAL, [EXIT]).map((r) => r.runId)).toEqual([again.runId]);
  });

  it('a claim refuses a run whose routine changed after the push', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    driver.exec(`UPDATE routine_names SET step_hash = ? WHERE routine_id = ?`, HASH_B, EXIT.routineId);
    expect(store.claim(run.runId, PRINCIPAL)).toEqual({ ok: false, reason: 'changed' });
  });

  it('a claim that never reports becomes unknown, and a late result is still heard', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    store.claim(run.runId, PRINCIPAL);
    expect(store.takeStaleClaims(NOW + ROUTINE_STALE_CLAIM_MS - 1)).toEqual([]);
    expect(store.takeStaleClaims(NOW + ROUTINE_STALE_CLAIM_MS).map((r) => r.runId)).toEqual([run.runId]);
    const late = store.settle(run.runId, PRINCIPAL, 'verified', null);
    expect(late).toMatchObject({ status: 'done', wasUnknown: true });
  });

  it('a locked phone settles a pushed run as failed, without a claim', () => {
    const run = schedule(NOW);
    store.takeDue(NOW);
    expect(store.settle(run.runId, PRINCIPAL, 'blocked', 'locked')?.status).toBe('failed');
  });

  it('wakes the alarm for the notice, the push, the re-push and the sweep', () => {
    const run = schedule(NOW + 30 * 60_000);
    expect(store.nextWakeAt()).toBe(run.dueAtUtc - ROUTINE_NOTICE_MS);
    store.takeNotices(run.dueAtUtc - ROUTINE_NOTICE_MS);
    expect(store.nextWakeAt()).toBe(run.dueAtUtc);
    store.takeDue(run.dueAtUtc);
    expect(store.nextWakeAt()).toBe(run.dueAtUtc + ROUTINE_REPUSH_MS);
  });
});

describe('routine.run', () => {
  let driver: TestSqlDriver;
  let store: RoutineStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    store = new RoutineStore(driver, () => NOW);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      routines: store,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  const question = (slots: unknown, c: ToolContext = ctx) => {
    const out = routineRun.resolve(slots, c);
    return out.kind === 'clarify' && out.clarify.code === 'personal' ? out.clarify.what : out.kind;
  };

  it('asks for what it cannot know, and never guesses a routine', () => {
    expect(question({ routine: ['כניסה'] })).toBe('no_routines');
    store.replaceNames(PRINCIPAL, [EXIT, ENTRY]);
    expect(question({})).toBe('routine_name');
    expect(question({ routine: ['הפסקה'] })).toBe('routine_unknown');
    store.replaceNames(PRINCIPAL, [EXIT, { ...ENTRY, name: 'יציאה לחופשה' }]);
    expect(question({ routine: ['יציאה'] })).toBe('routine_ambiguous');
  });

  it('an exact name wins over a partial one', () => {
    expect(findRoutine([EXIT, ENTRY, { ...ENTRY, routineId: 'x', name: 'כניסה מאוחרת' }], ['כניסה'])).toEqual(ENTRY);
  });

  it('runs now when no day or time was said, and in fifteen minutes when that was', () => {
    store.replaceNames(PRINCIPAL, [EXIT]);
    const now = routineRun.resolve({ routine: ['יציאה מהעבודה'] }, ctx);
    expect(now).toMatchObject({ kind: 'ready', input: { now: true, dueAtUtc: NOW, routineId: EXIT.routineId, stepHash: HASH_A } });
    const later = routineRun.resolve({ routine: ['יציאה מהעבודה'], date: { kind: 'in_duration', minutes: 15 } }, ctx);
    expect(later).toMatchObject({ kind: 'ready', input: { now: false, dueAtUtc: NOW + 15 * 60_000 } });
  });

  it('refuses more than seven days ahead, and a missing time is asked, never defaulted', () => {
    store.replaceNames(PRINCIPAL, [EXIT]);
    expect(question({ routine: ['יציאה מהעבודה'], date: { kind: 'relative_days', offset: 8 }, time: { hour: 17, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } })).toBe('routine_far');
    expect(routineRun.resolve({ routine: ['יציאה מהעבודה'], date: { kind: 'relative_days', offset: 1 } }, ctx)).toMatchObject({ kind: 'clarify', clarify: { code: 'time' } });
  });

  it('a tainted turn cannot schedule one at all', () => {
    store.replaceNames(PRINCIPAL, [EXIT]);
    expect(question({ routine: ['יציאה מהעבודה'] }, { ...ctx, tainted: true })).toBe('routine_tainted');
  });

  it('is Tier 2: always confirmed in the chat first', () => {
    const decision = decide('routine.run', {
      nowMs: NOW,
      messageSentAtMs: NOW,
      forwarded: false,
      paused: false,
      usage: { perHour: 0, perDay: 0 },
      limits: DEFAULT_LIMITS,
      horizonExceeded: false,
      source: 'text',
    });
    expect(decision.decision).toBe('CONFIRM');
    expect(decision.tier).toBe(2);
  });

  it('the preview shows the routine, its app, and the weekday, date and time', () => {
    store.replaceNames(PRINCIPAL, [EXIT]);
    const out = routineRun.resolve({ routine: ['יציאה מהעבודה'], date: { kind: 'in_duration', minutes: 15 } }, ctx);
    if (out.kind !== 'ready') throw new Error('expected ready');
    expect(plain(routineRun.preview(out.input, 'he'))).toBe(
      'להפעיל את השגרה יציאה מהעבודה באפליקציה clock2go2020 ביום א׳ 11.10 · 10:15? שתי דקות לפני תגיע התראה עם כפתור ביטול.',
    );
  });

  it('executes the stored input, and refuses steps changed since the confirmation', async () => {
    store.replaceNames(PRINCIPAL, [EXIT]);
    const out = routineRun.resolve({ routine: ['יציאה מהעבודה'], date: { kind: 'in_duration', minutes: 15 } }, ctx);
    if (out.kind !== 'ready') throw new Error('expected ready');

    store.replaceNames(PRINCIPAL, [{ ...EXIT, stepHash: HASH_B }]);
    const refused = await routineRun.execute(out.input, ctx);
    expect(plain(refused.text)).toContain('השתנתה');
    expect(store.open(PRINCIPAL)).toEqual([]);

    store.replaceNames(PRINCIPAL, [EXIT]);
    const done = await routineRun.execute(out.input, ctx);
    expect(done.rescheduleAlarm).toBe(true);
    expect(store.open(PRINCIPAL).map((r) => r.dueAtUtc)).toEqual([NOW + 15 * 60_000]);
  });
});

describe('offering routine.run', () => {
  let driver: TestSqlDriver;
  let store: RoutineStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new RoutineStore(driver, () => NOW);
  });
  afterEach(() => driver.close());

  it('only when the words name a synced routine, or say "routine" (D4)', () => {
    expect(namesRoutine('תפעיל יציאה מהעבודה בעוד רבע שעה', store, PRINCIPAL)).toBe(false); // nothing synced
    store.replaceNames(PRINCIPAL, [EXIT]);
    expect(namesRoutine('תפעיל יציאה מהעבודה בעוד רבע שעה', store, PRINCIPAL)).toBe(true);
    expect(namesRoutine('תפעיל את השגרה', store, PRINCIPAL)).toBe(true);
    expect(namesRoutine('מה מזג האוויר מחר', store, PRINCIPAL)).toBe(false);
  });

  it('is never in the catalog otherwise, and stays in a narrowed one when offered', () => {
    expect(agentToolNames({ cards: true })).not.toContain('routine.run');
    const offered = agentToolNames({ cards: true, routines: true });
    expect(offered).toContain('routine.run');
    expect(agentToolNames({ cards: true, routines: true, readOnly: true })).not.toContain('routine.run');
    // "in a quarter of an hour" selects the time group; the routine stays.
    expect(selectTools('תזכיר לי בעוד רבע שעה', offered).tools).toContain('routine.run');
  });
});

describe('the wire', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('the sync carries names and hashes, never a step', () => {
    const routine = { id: EXIT.routineId, name: EXIT.name, appLabel: EXIT.appLabel, stepHash: HASH_A };
    expect(parseRoutineSync(bytes({ routines: [routine] }))).not.toBeNull();
    expect(parseRoutineSync(bytes({ routines: [{ ...routine, steps: [{ kind: 'TAP_TEXT', value: 'כניסה' }] }] }))).toBeNull();
    expect(parseRoutineSync(bytes({ routines: [{ ...routine, stepHash: 'zz' }] }))).toBeNull();
    expect(parseRoutineSync(bytes({ routines: [{ ...routine, name: 'א'.repeat(41) }] }))).toBeNull();
  });

  it('the claim and the result are an opaque id and codes', () => {
    expect(parseRoutineClaim(bytes({ runId: 'a'.repeat(32) }))).not.toBeNull();
    expect(parseRoutineClaim(bytes({ runId: 'a'.repeat(32), routineId: EXIT.routineId }))).toBeNull();
    expect(parseRoutineResult(bytes({ runId: 'a'.repeat(32), outcome: 'verified' }))).not.toBeNull();
    expect(parseRoutineResult(bytes({ runId: 'a'.repeat(32), outcome: 'failed_before_tap', reason: 'target_disabled' }))).not.toBeNull();
    expect(parseRoutineResult(bytes({ runId: 'a'.repeat(32), outcome: 'verified', screen: 'שלום' }))).toBeNull();
    expect(parseRoutineResult(bytes({ runId: 'a'.repeat(32), outcome: 'failed_before_tap', reason: 'free text' }))).toBeNull();
  });

  it('the Worker lets the three routes through, on the app channel only, size-capped', () => {
    for (const path of ['/app/routines', '/app/routine/claim', '/app/routine/result']) {
      const route = APP_ROUTES.find((r) => r.method === 'POST' && r.pattern.test(path));
      expect(route?.channels).toEqual(['app']);
      expect(route!.maxBytes).toBeLessThanOrEqual(16_384);
    }
  });
});

describe('routine.run in a turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let store: RoutineStore;
  let agents: FakeAgent[];
  let seq = 0;

  const deps = (steps: FakeStep[]): PipelineDeps => {
    const agent = createFakeAgent(steps);
    agents.push(agent);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      routines: store,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: {
        providers: [agent],
        budget: new TokenBudget(() => NOW),
        history: new ConversationHistory(driver, () => NOW, keyring),
        lock: new AgentLock(driver, () => NOW),
      },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app' };
  };
  const say = (body: string, forwarded = false): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.routine.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded }) as InboundEvent;
  const tap = (buttonId: string): InboundEvent =>
    ({ kind: 'button', wamid: `wamid.routine.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, buttonId, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    store = new RoutineStore(driver, () => NOW);
    store.replaceNames(PRINCIPAL, [EXIT]);
    agents = [];
  });
  afterEach(() => driver.close());

  const call: FakeStep = { tool: 'routine.run', args: { routine: ['יציאה מהעבודה'], date: { kind: 'in_duration', minutes: 15 } } };

  it('asks to confirm, and schedules only after the tap', async () => {
    const out = await handleInbound(say('בעוד רבע שעה תפעיל את יציאה מהעבודה'), deps([call]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(plain(out.text)).toContain('להפעיל את השגרה יציאה מהעבודה');
    expect(out.private).toBe(true);
    expect(store.open(PRINCIPAL)).toEqual([]);

    const confirm = out.buttons?.find((b) => b.id.endsWith(':ok'));
    const done = await handleInbound(tap(confirm!.id), deps([]));
    if (done.action !== 'reply') throw new Error('expected a reply');
    expect(plain(done.text)).toContain('נקבע');
    expect(store.open(PRINCIPAL)).toHaveLength(1);
  });

  it('text someone else wrote cannot schedule one, not even with a tap', async () => {
    const out = await handleInbound(say('בעוד רבע שעה תפעיל את יציאה מהעבודה', true), deps([call]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(plain(out.text)).toContain('לא מטקסט ששותף או הועבר');
    expect(out.buttons ?? []).toEqual([]);
    expect(store.open(PRINCIPAL)).toEqual([]);
  });

  it('the cancel button on the notice stops the run', async () => {
    const { run } = store.schedule({ principal: PRINCIPAL, routine: EXIT, dueAtUtc: NOW + ROUTINE_NOTICE_MS, tz: 'Asia/Jerusalem' });
    const [notice] = store.takeNotices(NOW);
    const out = await handleInbound(tap(`rt:${run.runId}:${notice!.nonce}:no`), deps([]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(plain(out.text)).toBe('בוטל. יציאה מהעבודה לא תופעל.');
    expect(store.get(run.runId)?.status).toBe('cancelled');
  });

  it('is not offered when the message names no routine', async () => {
    await handleInbound(say('מה נשמע?'), deps([{ text: 'הכול טוב' }]));
    const offered = JSON.stringify(agents[0]!.tools[0] ?? []);
    expect(offered).not.toContain('routine');
  });
});
