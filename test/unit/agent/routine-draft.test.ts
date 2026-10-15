/**
 * The routine draft's model call (docs/plans/routine-builder.md, part 1): the
 * strict reply schema, code's checks after it (no invented text, the screen
 * policy), the two model families, the screen's day share, and what is never
 * stored or logged. Written before the code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { DraftStore } from '../../../src/tools/routine-draft-store.js';
import type { Draft, DraftMode } from '../../../src/tools/routine-draft-store.js';
import { ScreenStore } from '../../../src/tools/screen-store.js';
import type { AllowedApp } from '../../../src/tools/screen-store.js';
import {
  checkDraft,
  parseDraftReply,
  ROUTINE_DRAFT_PROMPT_VERSION,
  runRoutineDraft,
} from '../../../src/agent/routine-draft.js';
import type { DraftDeps } from '../../../src/agent/routine-draft.js';
import type { Screen } from '../../../src/agent/screen-step.js';
import { DRAFT_MODELS, DRAFT_SMART_MODELS, GEMINI_FLASH, GEMINI_FLASH_LITE, GPT_OSS_120B, QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-15T07:00:00Z');
const PRINCIPAL = 'p_draft_model';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const CLOCK: AllowedApp = { package: 'com.attendance.app', label: 'נוכחות', askEveryTap: false };
const b = (n: number) => n.toString(16).padStart(32, '0');

/** The attendance app's first screen: a greeting, a status line, two buttons, a field, a send button, a generic one. */
const FIRST: Screen = {
  hash: 'd'.repeat(64),
  elements: [
    { i: 0, t: 'שלום, דנה', f: '' },
    { i: 1, t: 'לא נרשמה כניסה היום', f: '' },
    { i: 2, t: 'כניסה', v: 'btn_in', f: 'c', b: b(1) },
    { i: 3, t: 'יציאה', f: 'c', b: b(2) },
    { i: 4, h: 'הערה', v: 'note', f: 'ce', b: b(3) },
    { i: 5, t: 'שלח דיווח', f: 'c', b: b(4) },
    { i: 6, t: 'המשך', f: 'c', b: b(5) },
    { i: 7, f: 'c', b: b(6) },
  ],
};

const reply = (value: unknown) => ({ text: JSON.stringify(value) });

describe('the reply schema and its checks', () => {
  const ctx = { elements: FIRST.elements, words: ['נרשמה', 'כניסה'], inputs: ['עבודה מהבית'] };
  const check = (value: unknown) => {
    const parsed = parseDraftReply(JSON.stringify(value));
    return parsed ? checkDraft(parsed, ctx) : { ok: false as const, why: 'schema' };
  };

  it('maps indexes to the phone\'s bindings and words to the confirmed text', () => {
    const out = check({
      steps: [
        { kind: 'TAP_TEXT', element: 2 },
        { kind: 'TYPE_TEXT', input: 1, element: 4 },
        { kind: 'SUBMIT' },
        { kind: 'WAIT', seconds: 2 },
        { kind: 'EXPECT_TEXT', said: 'נרשמה' },
        { kind: 'EXPECT_DISABLED', element: 2, seconds: 20 },
      ],
      note: 'ראיתי כפתור כניסה',
    });
    expect(out).toEqual({
      ok: true,
      steps: [
        { kind: 'TAP_TEXT', b: b(1), seconds: 15 },
        { kind: 'TYPE_TEXT', input: 1, b: b(3), seconds: 15 },
        { kind: 'SUBMIT', seconds: 15 },
        { kind: 'WAIT', seconds: 2 },
        { kind: 'EXPECT_TEXT', text: 'נרשמה', seconds: 15 },
        { kind: 'EXPECT_DISABLED', b: b(1), seconds: 20 },
      ],
      note: 'ראיתי כפתור כניסה',
    });
  });

  it('names a read-only element by its index, and a tap by id only on an element with one', () => {
    expect(check({ steps: [{ kind: 'TAP_ID', element: 2 }, { kind: 'EXPECT_TEXT', element: 1 }] })).toEqual({
      ok: true,
      steps: [
        { kind: 'TAP_ID', b: b(1), seconds: 15 },
        { kind: 'EXPECT_TEXT', i: 1, seconds: 15 },
      ],
    });
    expect(check({ steps: [{ kind: 'TAP_ID', element: 3 }] })).toMatchObject({ ok: false });
  });

  it('refuses invented text, unknown fields and wrong fields per kind', () => {
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'TAP_TEXT', text: 'כניסה' }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'TAP_ID', said: 'כניסה' }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'TAP_TEXT', element: 2, said: 'כניסה' }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'SUBMIT', element: 4 }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'WAIT', seconds: 9 }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'CALL', element: 2 }] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: Array.from({ length: 11 }, () => ({ kind: 'TAP_TEXT', element: 2 })) }))).toBeNull();
    expect(parseDraftReply(JSON.stringify({ steps: [{ kind: 'TAP_TEXT', element: 2 }], note: 'x'.repeat(121) }))).toBeNull();
  });

  it('refuses a `said` not among the confirmed words, an unknown index and an input that does not exist', () => {
    expect(check({ steps: [{ kind: 'TAP_TEXT', said: 'יציאה' }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'TAP_TEXT', element: 40 }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'TYPE_TEXT', input: 2 }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'TYPE_TEXT', input: 1, element: 2 }] })).toMatchObject({ ok: false });
  });

  it('refuses sensitive and uncertain taps, and a sensitive word in any text', () => {
    expect(check({ steps: [{ kind: 'TAP_TEXT', element: 5 }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'TAP_TEXT', element: 6 }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'TAP_ID', element: 7 }] })).toMatchObject({ ok: false });
    const sensitive = { elements: FIRST.elements, words: ['שלח טופס', 'הצלחה'], inputs: ['שלם עכשיו'] };
    const run = (value: unknown) => checkDraft(parseDraftReply(JSON.stringify(value))!, sensitive);
    expect(run({ steps: [{ kind: 'TAP_TEXT', said: 'שלח טופס' }] })).toMatchObject({ ok: false });
    expect(run({ steps: [{ kind: 'TAP_TEXT', element: 2 }, { kind: 'EXPECT_TEXT', said: 'שלח טופס' }] })).toMatchObject({ ok: false });
    expect(run({ steps: [{ kind: 'TYPE_TEXT', input: 1 }, { kind: 'SUBMIT' }] })).toMatchObject({ ok: false });
    // "type, then Enter" and a check are not generic: allowed.
    expect(check({ steps: [{ kind: 'TYPE_TEXT', input: 1 }, { kind: 'SUBMIT' }, { kind: 'EXPECT_TEXT', said: 'נרשמה' }] })).toMatchObject({ ok: true });
  });

  it('needs an action, and checks only after the last one', () => {
    expect(check({ steps: [{ kind: 'EXPECT_TEXT', said: 'נרשמה' }] })).toMatchObject({ ok: false });
    expect(check({ steps: [{ kind: 'EXPECT_TEXT', said: 'נרשמה' }, { kind: 'TAP_TEXT', element: 2 }] })).toMatchObject({ ok: false });
  });
});

describe('the model families', () => {
  it('never cross and never hold Flash', () => {
    expect(DRAFT_MODELS).toEqual([QWEN, GPT_OSS_120B]);
    expect(DRAFT_SMART_MODELS).toEqual([GEMINI_FLASH_LITE]);
    expect(DRAFT_MODELS.some((id) => SMART_MODELS.some((m) => m.id === id))).toBe(false);
    expect([...DRAFT_MODELS, ...DRAFT_SMART_MODELS]).not.toContain(GEMINI_FLASH);
    expect(ROUTINE_DRAFT_PROMPT_VERSION).toBe('rd1');
  });
});

describe('one draft call', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let drafts: DraftStore;
  let screen: ScreenStore;
  let budget: TokenBudget;
  let log: ReturnType<typeof createFakeLogger>;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    drafts = new DraftStore(driver, () => clock, keyring);
    screen = new ScreenStore(driver, () => clock, keyring);
    screen.replaceAllow(PRINCIPAL, [CLOCK]);
    budget = new TokenBudget(() => clock);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  const deps = (local: FakeAgent[], smart: FakeAgent[] = []): DraftDeps => ({
    store: drafts,
    screen,
    budget,
    providersFor: (mode: DraftMode) => (mode === 'smart' ? smart : local),
    log,
    now: () => clock,
  });
  const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 1_200);
  const oss = (steps: FakeStep[]) => createFakeAgent(steps, GPT_OSS_120B, 1_200);
  const lite = (steps: FakeStep[]) => createFakeAgent(steps, GEMINI_FLASH_LITE, 1_200, 'smart');

  async function claimed(mode: DraftMode = 'local', words = ['כניסה', 'נרשמה'], inputs: string[] = []): Promise<Draft> {
    const draft = await drafts.create({ principal: PRINCIPAL, package: CLOCK.package, appLabel: CLOCK.label, goal: 'להחתים כניסה', inputs, words, mode });
    drafts.takePushes();
    drafts.claim(draft.draftId, PRINCIPAL);
    return draft;
  }
  const good = reply({ steps: [{ kind: 'TAP_TEXT', element: 2 }, { kind: 'EXPECT_TEXT', said: 'נרשמה' }] });

  it('drafts once, counts the screen share, and keeps no screen or step text', async () => {
    const draft = await claimed();
    const model = qwen([good]);
    const out = await runRoutineDraft(deps([model]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out).toMatchObject({ kind: 'drafted', steps: [{ kind: 'TAP_TEXT', b: b(1) }, { kind: 'EXPECT_TEXT', text: 'נרשמה' }] });
    expect(drafts.get(draft.draftId)?.status).toBe('drafted');
    expect(screen.modelDayTokens(PRINCIPAL, QWEN)).toBe(1_200);
    // The model saw the screen, scrubbed, and the words; never a binding.
    const sent = JSON.stringify(model.calls[0]);
    expect(sent).toContain('לא נרשמה כניסה היום');
    expect(sent).not.toContain(b(1));
    // Nothing of the screen, the request or the steps is stored or logged.
    const rows = JSON.stringify(driver.exec(`SELECT * FROM routine_drafts`));
    for (const secret of ['לא נרשמה', 'שלום, דנה', 'להחתים', 'נרשמה', b(1)]) {
      expect(rows).not.toContain(secret);
      expect(JSON.stringify(log.captured)).not.toContain(secret);
    }
    // A repeat post is refused.
    expect(await runRoutineDraft(deps([qwen([good])]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST })).toEqual({ kind: 'conflict' });
  });

  it('asks the next model of the family once, then fails with a code', async () => {
    const draft = await claimed();
    const bad = reply({ steps: [{ kind: 'TAP_TEXT', said: 'שלח' }] });
    const first = qwen([bad]);
    const second = oss([good]);
    const out = await runRoutineDraft(deps([first, second]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out.kind).toBe('drafted');
    expect(first.calls).toHaveLength(1);

    const again = await claimed();
    const out2 = await runRoutineDraft(deps([qwen([bad]), oss([{ text: 'not json' }])]), { draftId: again.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out2).toMatchObject({ kind: 'failed', ended: { reason: 'model_error', draft: { status: 'failed' } } });
    expect(await drafts.unseal(again.draftId)).toBeNull();
  });

  it('a smart draft asks only Flash-Lite, and its tokens are not Groq\'s share', async () => {
    const draft = await claimed('smart');
    const local = qwen([good]);
    const smart = lite([good]);
    const out = await runRoutineDraft(deps([local], [smart]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out.kind).toBe('drafted');
    expect(local.calls).toHaveLength(0);
    expect(smart.calls).toHaveLength(1);
    expect(screen.modelDayTokens(PRINCIPAL, QWEN)).toBe(0);
  });

  it('a Groq model whose screen share is spent is skipped; all spent is quota', async () => {
    screen.addModelDayTokens(PRINCIPAL, QWEN, 50_000);
    screen.addModelDayTokens(PRINCIPAL, GPT_OSS_120B, 50_000);
    const draft = await claimed();
    const model = qwen([good]);
    const out = await runRoutineDraft(deps([model, oss([good])]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out).toMatchObject({ kind: 'failed', ended: { reason: 'quota' } });
    expect(model.calls).toHaveLength(0);
  });

  it('an app taken off the list ends the draft before any model call', async () => {
    const draft = await claimed();
    screen.replaceAllow(PRINCIPAL, []);
    const model = qwen([good]);
    const out = await runRoutineDraft(deps([model]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    expect(out).toMatchObject({ kind: 'failed', ended: { reason: 'not_allowed' } });
    expect(model.calls).toHaveLength(0);
  });

  it('shows the words to the model, a value scrubbing would change only as hidden', async () => {
    const draft = await claimed('local', ['כניסה'], ['050-1234567']);
    const model = qwen([good]);
    await runRoutineDraft(deps([model]), { draftId: draft.draftId, principal: PRINCIPAL, screen: FIRST });
    const sent = JSON.stringify(model.calls[0]);
    expect(sent).toContain('כניסה');
    expect(sent).not.toContain('050-1234567');
  });
});
