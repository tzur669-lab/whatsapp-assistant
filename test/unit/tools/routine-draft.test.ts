/**
 * The bot builds a routine draft (docs/plans/routine-builder.md, part 1):
 * the draft store's one-way moves and sweeps, the `routine.draft` tool, when
 * it is offered, the `tested` gate on `routine.run`, and the strict routes.
 * Written before the code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { DraftStore, DRAFT_TTL_MS, OPEN_DRAFT_STATUSES } from '../../../src/tools/routine-draft-store.js';
import { namesRoutineBuild, routineDraft } from '../../../src/tools/routine-draft.js';
import { ScreenStore } from '../../../src/tools/screen-store.js';
import type { AllowedApp } from '../../../src/tools/screen-store.js';
import { screenTask } from '../../../src/tools/screen.js';
import { RoutineStore } from '../../../src/tools/routine-store.js';
import { routineRun } from '../../../src/tools/routines.js';
import { REGISTRY } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { selectTools } from '../../../src/agent/tool-groups.js';
import {
  KNOWN_CAPS,
  parsePushToken,
  parseRoutineDraftClaim,
  parseRoutineDraftResult,
  parseRoutineDraftScreen,
  parseRoutineSync,
} from '../../../src/channels/app/parse.js';
import { APP_ROUTES } from '../../../src/channels/app/ingress.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { draftText } from '../../../src/render/routine-draft.js';
import { screenText } from '../../../src/render/screen.js';
import { personalQuestion } from '../../../src/render/personal.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-10-15T07:00:00Z');
const PRINCIPAL = 'p_draft';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const CLOCK: AllowedApp = { package: 'com.attendance.app', label: 'נוכחות', askEveryTap: false };
const FID: AllowedApp = { package: 'il.co.fid', label: 'FID', askEveryTap: false };
const UUID = '0b6f3c1e-1111-4222-8333-944455556666';
const HASH = 'a'.repeat(64);
const b = (n: number) => n.toString(16).padStart(32, '0');
const plain = (text: string) => stripIsolates(text);
const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('the draft store', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let store: DraftStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    store = new DraftStore(driver, () => clock, keyring);
  });
  afterEach(() => driver.close());

  const create = () =>
    store.create({ principal: PRINCIPAL, package: CLOCK.package, appLabel: CLOCK.label, goal: 'ללחוץ כניסה', inputs: [], words: ['כניסה'], mode: 'local' });

  it('seals the request and keeps no words in the clear', async () => {
    const draft = await create();
    expect(draft.status).toBe('confirmed');
    const row = driver.exec(`SELECT * FROM routine_drafts WHERE draft_id = ?`, draft.draftId)[0]!;
    expect(JSON.stringify(row)).not.toContain('כניסה');
    expect(await store.unseal(draft.draftId)).toEqual({ goal: 'ללחוץ כניסה', inputs: [], words: ['כניסה'] });
  });

  it('moves confirmed → pushed → claimed once, and the screen post once', async () => {
    const draft = await create();
    expect(store.claim(draft.draftId, PRINCIPAL)).toMatchObject({ ok: false });
    expect(store.takePushes().map((d) => d.draftId)).toEqual([draft.draftId]);
    expect(store.takePushes()).toEqual([]);
    expect(store.claim(draft.draftId, 'someone_else')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(store.claim(draft.draftId, PRINCIPAL)).toMatchObject({ ok: true });
    expect(store.claim(draft.draftId, PRINCIPAL)).toMatchObject({ ok: false, reason: 'already' });
    expect(store.beginScreen(draft.draftId, PRINCIPAL)).not.toBeNull();
    // A repeat post while the model thinks, or after it answered: refused.
    expect(store.beginScreen(draft.draftId, PRINCIPAL)).toBeNull();
    expect(store.drafted(draft.draftId)?.status).toBe('drafted');
    expect(store.beginScreen(draft.draftId, PRINCIPAL)).toBeNull();
    // The model answered: the sealed request is gone.
    expect(await store.unseal(draft.draftId)).toBeNull();
  });

  it('takes the closed result codes only from their own status', async () => {
    const draft = await create();
    store.takePushes();
    store.claim(draft.draftId, PRINCIPAL);
    // `offered` before any draft exists: refused.
    expect(store.result(draft.draftId, PRINCIPAL, 'offered')).toEqual({ kind: 'refused' });
    expect(store.result(draft.draftId, PRINCIPAL, 'locked')).toMatchObject({ kind: 'moved', ended: { draft: { status: 'failed', reason: 'locked' } } });
    expect(store.result(draft.draftId, PRINCIPAL, 'locked')).toEqual({ kind: 'refused' });

    const second = await create();
    store.takePushes();
    store.claim(second.draftId, PRINCIPAL);
    store.beginScreen(second.draftId, PRINCIPAL);
    // In flight: the phone cannot end it with a pre-screen code.
    expect(store.result(second.draftId, PRINCIPAL, 'app_not_front')).toEqual({ kind: 'refused' });
    store.drafted(second.draftId);
    expect(store.result(second.draftId, PRINCIPAL, 'launch_confirm')).toEqual({ kind: 'refused' });
    expect(store.result(second.draftId, PRINCIPAL, 'slot_busy')).toMatchObject({ kind: 'moved', ended: { draft: { status: 'slot_busy' } } });
    expect(store.result(second.draftId, PRINCIPAL, 'offered')).toEqual({ kind: 'refused' });
  });

  it('fails a claimed draft once, and clears its sealed request', async () => {
    const draft = await create();
    store.takePushes();
    store.claim(draft.draftId, PRINCIPAL);
    store.beginScreen(draft.draftId, PRINCIPAL);
    expect(store.fail(draft.draftId, 'model_error')?.draft.status).toBe('failed');
    expect(store.fail(draft.draftId, 'model_error')).toBeNull();
    expect(await store.unseal(draft.draftId)).toBeNull();
  });

  it('sweeps pushed → expired, claimed → unknown and drafted → unknown after 10 minutes, each once', async () => {
    const pushed = await create();
    store.takePushes();
    clock += DRAFT_TTL_MS - 1;
    expect(store.sweep()).toEqual([]);
    clock += 2;
    expect(store.sweep().map((e) => [e.draft.draftId, e.draft.status])).toEqual([[pushed.draftId, 'expired']]);
    expect(store.sweep()).toEqual([]);

    const claimed = await create();
    store.takePushes();
    store.claim(claimed.draftId, PRINCIPAL);
    const drafted = await create();
    store.takePushes();
    store.claim(drafted.draftId, PRINCIPAL);
    store.beginScreen(drafted.draftId, PRINCIPAL);
    store.drafted(drafted.draftId);
    expect(store.nextWakeAt()).toBe(clock + DRAFT_TTL_MS + 1);
    clock += DRAFT_TTL_MS + 1;
    const swept = store.sweep().map((e) => e.draft.status);
    expect(swept).toEqual(['unknown', 'unknown']);
    expect(store.active(PRINCIPAL)).toBeNull();
  });

  it('gives way to a due routine through its own preempt', async () => {
    const draft = await create();
    expect(store.active(PRINCIPAL)?.draftId).toBe(draft.draftId);
    const ended = store.preempt(PRINCIPAL);
    expect(ended.map((e) => e.draft.status)).toEqual(['preempted']);
    expect(store.preempt(PRINCIPAL)).toEqual([]);
    expect(OPEN_DRAFT_STATUSES).toEqual(['confirmed', 'pushed', 'claimed', 'drafted']);
  });

  it('a late claim is refused and the draft expires', async () => {
    const draft = await create();
    store.takePushes();
    clock += DRAFT_TTL_MS + 1;
    expect(store.claim(draft.draftId, PRINCIPAL)).toMatchObject({ ok: false, reason: 'late' });
    expect(store.get(draft.draftId)?.status).toBe('expired');
  });
});

describe('routine.draft, the tool', () => {
  let driver: TestSqlDriver;
  let screen: ScreenStore;
  let drafts: DraftStore;
  let routines: RoutineStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    screen = new ScreenStore(driver, () => NOW, keyring);
    drafts = new DraftStore(driver, () => NOW, keyring);
    routines = new RoutineStore(driver, () => NOW);
    screen.replaceAllow(PRINCIPAL, [CLOCK, FID]);
  });
  afterEach(() => driver.close());

  const ctx = (userText: string, extra: Partial<ToolContext> = {}): ToolContext =>
    ({ principal: PRINCIPAL, nowMs: NOW, lang: 'he', channel: 'app', screen, drafts, routines, userText, ...extra }) as unknown as ToolContext;
  const said = 'תבנה שגרה: באפליקציית הנוכחות ללחוץ כניסה';

  it('is ready with the app found by code and the words said in the message', () => {
    const out = routineDraft.resolve({ app: 'נוכחות', goal: 'ללחוץ כניסה', words: ['כניסה'] }, ctx(said));
    expect(out).toEqual({
      kind: 'ready',
      input: { package: CLOCK.package, appLabel: CLOCK.label, goal: 'ללחוץ כניסה', inputs: [], words: ['כניסה'] },
    });
    const card = plain(routineDraft.preview((out as { input: unknown }).input, 'he'));
    expect(card).toContain('כניסה');
    expect(card).toContain(CLOCK.label);
  });

  it('refuses words and inputs not in the message, a tainted turn, another channel and an unknown app', () => {
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g', words: ['יציאה'] }, ctx(said))).toMatchObject({ clarify: { what: 'word_not_said' } });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g', inputs: ['admin'] }, ctx(said))).toMatchObject({ clarify: { what: 'input_not_said' } });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g' }, ctx(said, { tainted: true }))).toMatchObject({ clarify: { what: 'tainted' } });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g' }, ctx(said, { channel: 'whatsapp' }))).toMatchObject({ clarify: { what: 'not_app' } });
    expect(routineDraft.resolve({ app: 'בנק', goal: 'g' }, ctx(said))).toMatchObject({ clarify: { what: 'app_unknown' } });
    expect(routineDraft.resolve({ app: 'נוכחות' }, ctx(said))).toMatchObject({ clarify: { what: 'goal' } });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g', words: ['1', '2', '3', '4', '5', '6'] }, ctx('1 2 3 4 5 6'))).toMatchObject({
      clarify: { what: 'word_not_said' },
    });
  });

  it('is blocked by an open draft, an open screen task, and a routine due within 15 minutes', async () => {
    const draft = await drafts.create({ principal: PRINCIPAL, package: CLOCK.package, appLabel: CLOCK.label, goal: 'g', inputs: [], words: [], mode: 'local' });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g' }, ctx(said))).toMatchObject({ clarify: { what: 'draft_open' } });
    // The screen agent waits for the draft too.
    expect(screenTask.resolve({ app: 'FID', task: 't' }, ctx('תחפש בFID'))).toMatchObject({ clarify: { what: 'draft_open' } });
    drafts.preempt(PRINCIPAL);
    expect(drafts.get(draft.draftId)?.status).toBe('preempted');

    await screen.create({ principal: PRINCIPAL, package: FID.package, appLabel: 'FID', task: 't', inputs: [] });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g' }, ctx(said))).toMatchObject({ clarify: { what: 'busy' } });
    screen.preemptAll(PRINCIPAL);

    routines.replaceNames(PRINCIPAL, [{ routineId: UUID, name: 'כניסה', stepHash: HASH, appLabel: CLOCK.label }]);
    routines.schedule({ principal: PRINCIPAL, routine: { routineId: UUID, name: 'כניסה', stepHash: HASH, appLabel: CLOCK.label }, dueAtUtc: NOW + 14 * 60_000, tz: 'Asia/Jerusalem' });
    expect(routineDraft.resolve({ app: 'נוכחות', goal: 'g' }, ctx(said))).toMatchObject({ clarify: { what: 'draft_routine_soon' } });
  });

  it('executes the stored input into a sealed draft, smart only when confirmed so', async () => {
    const input = { package: CLOCK.package, appLabel: CLOCK.label, goal: 'ללחוץ כניסה', inputs: [], words: ['כניסה'], smart: true };
    const result = await routineDraft.execute(input, ctx(said));
    expect(result.rescheduleAlarm).toBe(true);
    const draft = drafts.get(result.externalRef!);
    expect(draft).toMatchObject({ status: 'confirmed', mode: 'smart', appLabel: CLOCK.label });
    // Still refused in a tainted turn.
    expect((await routineDraft.execute(input, ctx(said, { tainted: true }))).externalRef).toBeUndefined();
  });

  it('never keeps the message itself', () => {
    const out = routineDraft.resolve({ app: 'נוכחות', goal: 'ללחוץ כניסה', words: ['כניסה'] }, ctx(said)) as { input: object };
    expect(JSON.stringify(out.input)).not.toContain('תבנה');
  });

  it('is Tier 2, private, refused when tainted, ten a day', () => {
    expect(REGISTRY['routine.draft']).toMatchObject({ tier: 2, dataSource: 'private', private: true, refusesTainted: true });
    expect(REGISTRY['routine.draft'].rateLimit.perDay).toBe(10);
  });
});

describe('when routine.draft is offered', () => {
  const base = { cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } };

  it('needs both the words and the device cap', () => {
    expect(agentToolNames(base)).not.toContain('routine.draft');
    expect(agentToolNames({ ...base, routineBuild: true })).not.toContain('routine.draft');
    expect(agentToolNames({ ...base, routineDraftCap: true })).not.toContain('routine.draft');
    expect(agentToolNames({ ...base, routineBuild: true, routineDraftCap: true })).toContain('routine.draft');
    expect(agentToolNames({ ...base, routineBuild: true, routineDraftCap: true, readOnly: true })).not.toContain('routine.draft');
  });

  it('reads a routine word with a build verb, with no routine synced', () => {
    expect(namesRoutineBuild('תבנה לי שגרה שנכנסת לנוכחות')).toBe(true);
    expect(namesRoutineBuild('תיצור שגרה: בפיד לחפש סטימצקי')).toBe(true);
    expect(namesRoutineBuild('build a routine that taps clock in')).toBe(true);
    expect(namesRoutineBuild('תפעיל את השגרה כניסה')).toBe(false);
    expect(namesRoutineBuild('תבנה לי רשימת קניות')).toBe(false);
  });

  it('rides along in any selection, and leads one that names nothing else', () => {
    const offered = agentToolNames({ ...base, routineBuild: true, routineDraftCap: true, screen: true, routines: true });
    expect(selectTools('תבנה שגרה', offered).tools).toContain('routine.draft');
    expect(selectTools('תבנה שגרה', offered).tools).toContain('screen.task');
    expect(selectTools('תבנה שגרה באפליקציה של הנוכחות', offered).tools).toContain('routine.draft');
    const noRun = agentToolNames({ ...base, routineBuild: true, routineDraftCap: true });
    expect(selectTools('תבנה שגרה', noRun).tools).toContain('routine.draft');
  });
});

describe('the tested gate', () => {
  let driver: TestSqlDriver;
  let routines: RoutineStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    routines = new RoutineStore(driver, () => NOW);
  });
  afterEach(() => driver.close());

  const ctx = () => ({ principal: PRINCIPAL, nowMs: NOW, lang: 'he', channel: 'app', routines }) as unknown as ToolContext;

  it('a sync without `tested` is tested; an untested routine cannot be scheduled', async () => {
    const synced = parseRoutineSync(body({ routines: [{ id: UUID, name: 'כניסה', appLabel: 'נוכחות', stepHash: HASH }] }));
    expect(synced?.routines[0]?.tested).toBeUndefined();
    routines.replaceNames(PRINCIPAL, [{ routineId: UUID, name: 'כניסה', stepHash: HASH, appLabel: 'נוכחות' }]);
    expect(routines.names(PRINCIPAL)[0]?.tested).toBe(true);
    expect(routineRun.resolve({ routine: ['כניסה'] }, ctx())).toMatchObject({ kind: 'ready' });

    expect(parseRoutineSync(body({ routines: [{ id: UUID, name: 'כניסה', appLabel: 'נוכחות', stepHash: HASH, tested: false }] }))?.routines[0]?.tested).toBe(false);
    routines.replaceNames(PRINCIPAL, [{ routineId: UUID, name: 'כניסה', stepHash: HASH, appLabel: 'נוכחות', tested: false }]);
    expect(routines.names(PRINCIPAL)[0]?.tested).toBe(false);
    expect(routineRun.resolve({ routine: ['כניסה'] }, ctx())).toMatchObject({ clarify: { what: 'routine_untested' } });
    // A run confirmed while tested is refused if the phone now says untested.
    const input = { routineId: UUID, name: 'כניסה', appLabel: 'נוכחות', stepHash: HASH, dueAtUtc: NOW, tz: 'Asia/Jerusalem', now: true };
    expect((await routineRun.execute(input, ctx())).externalRef).toBeUndefined();
    expect(plain(personalQuestion('routine_untested', 'he'))).toContain('פעם אחת');
  });

  it('keeps routine_draft among the known caps', () => {
    expect(KNOWN_CAPS).toContain('routine_draft');
    expect(parsePushToken(body({ pushToken: 't', caps: ['routine_draft', 'nope'] }))?.caps).toEqual(['routine_draft']);
  });
});

describe('the draft routes', () => {
  it('parse strictly and are capped', () => {
    expect(parseRoutineDraftClaim(body({ draftId: b(1) }))).not.toBeNull();
    expect(parseRoutineDraftClaim(body({ draftId: b(1), goal: 'x' }))).toBeNull();
    const screenBody = { draftId: b(1), screen: { hash: 'c'.repeat(64), elements: [{ i: 0, t: 'כניסה', f: 'c', b: b(2) }] } };
    expect(parseRoutineDraftScreen(body(screenBody))).not.toBeNull();
    expect(parseRoutineDraftScreen(body({ ...screenBody, words: ['x'] }))).toBeNull();
    expect(parseRoutineDraftResult(body({ draftId: b(1), code: 'offered' }))).not.toBeNull();
    expect(parseRoutineDraftResult(body({ draftId: b(1), code: 'done' }))).toBeNull();
    for (const [path, max] of [
      ['/app/routine/draft/claim', 1_024],
      ['/app/routine/draft/screen', 16_384],
      ['/app/routine/draft/result', 1_024],
    ] as const) {
      const route = APP_ROUTES.find((r) => r.pattern.test(path));
      expect(route?.maxBytes).toBe(max);
      expect(route?.channels).toEqual(['app']);
    }
  });

  it('every end has a line of its own', () => {
    for (const reason of ['locked', 'app_not_front', 'launch_confirm', 'model_error', 'quota', 'busy', 'sealed_missing', 'not_allowed']) {
      expect(plain(draftText.failed(reason, 'נוכחות', 'he'))).toContain('נוכחות');
    }
    for (const status of ['offered', 'build_failed', 'slot_busy', 'expired', 'unknown', 'preempted'] as const) {
      expect(draftText.ended(status, 'נוכחות', 'he').length).toBeGreaterThan(10);
      expect(draftText.ended(status, 'נוכחות', 'en').length).toBeGreaterThan(10);
    }
    for (const what of ['draft_open', 'draft_routine_soon', 'goal', 'word_not_said'] as const) {
      expect(screenText.question(what, 'he').length).toBeGreaterThan(5);
    }
  });
});
