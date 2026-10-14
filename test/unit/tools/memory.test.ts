/**
 * Facts about the user (PLAN §6.26, ROADMAP block H part 18, 2026-10-07): what
 * may become one, how they are kept, and that the agent sees them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { FactStore, MAX_FACTS, MAX_FACTS_TOTAL_CHARS } from '../../../src/tools/fact-store.js';
import { memoryForget, memoryRemember } from '../../../src/tools/memory.js';
import { notesSave } from '../../../src/tools/notes.js';
import { containsPrivateData } from '../../../src/security/scrub.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-07T09:00:00Z');
const PRINCIPAL = 'p_facts';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const plain = (text: string) => stripIsolates(text);

describe('containsPrivateData', () => {
  it.each(['test@example.com', 'https://example.com/x', 'www.example.com', 'הקוד 4321', '050-0000000', 'מספר 1234567'])(
    'refuses "%s"',
    (text) => expect(containsPrivateData(text)).toBe(true),
  );

  it.each(['אני גר ברחובות', 'יש לי שני ילדים בני 5 ו-8', 'I am vegetarian', 'אשתי נקראת רונית', 'נולדתי ב-1990'])(
    'keeps "%s"',
    (text) => expect(containsPrivateData(text)).toBe(false),
  );

  it('gives the same answer twice (no state left in a global regex)', () => {
    expect(containsPrivateData('test@example.com')).toBe(true);
    expect(containsPrivateData('test@example.com')).toBe(true);
  });
});

describe('facts', () => {
  let driver: TestSqlDriver;
  let facts: FactStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    facts = new FactStore(driver, () => NOW, keyring);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      notes: new NoteStore(driver, () => NOW),
      facts,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  it('keeps ciphertext only, and reads it back in order', async () => {
    await facts.add(PRINCIPAL, 'אני גר ברחובות');
    await facts.add(PRINCIPAL, 'אני צמחוני');
    expect(JSON.stringify(driver.exec('SELECT * FROM facts'))).not.toContain('רחובות');
    expect((await facts.all(PRINCIPAL)).map((f) => f.text)).toEqual(['אני גר ברחובות', 'אני צמחוני']);
  });

  it('holds both caps: the count and the total length', async () => {
    for (let i = 0; i < MAX_FACTS; i++) expect((await facts.add(PRINCIPAL, `עובדה ${i}`)).kind).toBe('added');
    expect((await facts.add(PRINCIPAL, 'עוד אחת')).kind).toBe('full');
    facts.wipe(PRINCIPAL);
    for (let i = 0; i < MAX_FACTS_TOTAL_CHARS / 200; i++) await facts.add(PRINCIPAL, 'א'.repeat(200));
    expect((await facts.add(PRINCIPAL, 'ב')).kind).toBe('full');
  });

  it('drops a fact that no longer decrypts', async () => {
    await facts.add(PRINCIPAL, 'אני גר ברחובות');
    const rotated = new FactStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: OTHER_KEY }));
    expect(await rotated.all(PRINCIPAL)).toEqual([]);
    expect(driver.exec('SELECT * FROM facts')).toHaveLength(0);
  });

  describe('memory.remember', () => {
    it('refuses a number, a code, a link or an email, and points to notes', () => {
      expect(memoryRemember.resolve({ text: 'הקוד של השער 4321' }, ctx)).toMatchObject({ clarify: { what: 'fact_private' } });
    });

    it('kept at once only when the words asked for it; otherwise an offer (2026-10-14)', () => {
      expect(memoryRemember.resolve({ text: 'אני גר ברחובות' }, { ...ctx, explicitFact: true })).toEqual({
        kind: 'ready',
        input: { text: 'אני גר ברחובות' },
      });
      for (const unasked of [{ ...ctx, explicitFact: false }, ctx]) {
        expect(memoryRemember.resolve({ text: 'אני גר ברחובות' }, unasked)).toEqual({
          kind: 'ready',
          input: { text: 'אני גר ברחובות' },
          unrequested: true,
        });
      }
    });

    it('an offer still refuses taint and private data first', () => {
      expect(memoryRemember.resolve({ text: 'אני גר ברחובות' }, { ...ctx, tainted: true })).toMatchObject({ clarify: { what: 'fact_tainted' } });
      expect(memoryRemember.resolve({ text: 'הקוד שלי 4321' }, ctx)).toMatchObject({ clarify: { what: 'fact_private' } });
    });

    it('the card asks, it does not say it was kept', () => {
      const preview = plain(memoryRemember.preview({ text: 'אני לומד באריאל' }, 'he'));
      expect(preview).toContain('לשמור כעובדה עליך');
      expect(preview).not.toContain('נשמר');
    });

    it('asks what to keep when nothing was said', () => {
      expect(memoryRemember.resolve({}, ctx)).toMatchObject({ clarify: { what: 'fact_text' } });
    });

    it('refuses in a tainted turn, at execute too', async () => {
      const result = await memoryRemember.execute({ text: 'אני גר ברחובות' }, { ...ctx, tainted: true });
      expect(plain(result.text)).toContain('לא מטקסט ששותף');
      expect(await facts.all(PRINCIPAL)).toEqual([]);
    });

    it('keeps a fact, and Undo forgets it', async () => {
      const result = await memoryRemember.execute({ text: 'אני גר ברחובות' }, ctx);
      expect(plain(result.text)).toContain('נשמר כעובדה עליך');
      await memoryRemember.undo!(result.compensating, ctx);
      expect(await facts.all(PRINCIPAL)).toEqual([]);
    });
  });

  describe('memory.forget', () => {
    it('finds the fact by the words, and says when there is none', async () => {
      expect(await memoryForget.resolveAsync!({ query_variants: ['רחובות'] }, ctx)).toMatchObject({ clarify: { what: 'no_facts' } });
      await facts.add(PRINCIPAL, 'אני גר ברחובות');
      const out = await memoryForget.resolveAsync!({ query_variants: ['רחובות'] }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      expect(plain((await memoryForget.execute(out.input, ctx)).text)).toBe('העובדה נמחקה.');
      expect(memoryForget.undo).toBeUndefined();
    });
  });

  it('a note that reads like a fact about the user says where facts go', async () => {
    const result = await notesSave.execute({ text: 'אני אלרגי לבוטנים' }, ctx);
    expect(plain(result.text)).toContain('תזכור עליי ש');
    const other = await notesSave.execute({ text: 'החניה בקומה 2' }, ctx);
    expect(plain(other.text)).not.toContain('תזכור עליי');
  });
});

describe('facts in an agent turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let facts: FactStore;
  let notes: NoteStore;
  let agents: FakeAgent[];

  const deps = (steps: FakeStep[]): PipelineDeps => {
    const agent = createFakeAgent(steps);
    agents.push(agent);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      notes,
      facts,
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
  let seq = 0;
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.facts.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    facts = new FactStore(driver, () => NOW, keyring);
    notes = new NoteStore(driver, () => NOW);
    agents = [];
  });
  afterEach(() => driver.close());

  it('the model is told the facts, and never the notes', async () => {
    await facts.add(PRINCIPAL, 'אני גר ברחובות');
    notes.add(PRINCIPAL, 'הקוד של השער 4321');
    await handleInbound(say('מה נשמע?'), deps([{ text: 'הכול טוב' }]));
    const seen = seenByModel(agents[0]!);
    expect(seen).toContain('About the user: אני גר ברחובות');
    expect(seen).not.toContain('4321');
  });

  it('remembers through the tool, and /memory and /forget memory work', async () => {
    await handleInbound(say('תזכור עליי שאני צמחוני'), deps([{ tool: 'memory.remember', args: { text: 'אני צמחוני' } }]));
    notes.add(PRINCIPAL, 'פתק');
    const shown = await handleInbound(say('/memory'), deps([]));
    if (shown.action !== 'reply') throw new Error('expected a reply');
    expect(shown.private).toBe(true);
    expect(plain(shown.text)).toContain('1. אני צמחוני');
    expect(plain(shown.text)).toContain('יש גם 1 פתקים');
    await handleInbound(say('/forget memory'), deps([]));
    expect(await facts.all(PRINCIPAL)).toEqual([]);
  });

  it('a fact said in passing is offered on a card, and kept only on yes, with no Undo (2026-10-14)', async () => {
    const pending = new PendingActions(driver, () => NOW);
    const withPending = (steps: FakeStep[]): PipelineDeps => {
      const d = deps(steps);
      return { ...d, services: { ...d.services!, pending } };
    };
    const out = await handleInbound(
      say('אני לומד הנדסת תעשייה וניהול באריאל'),
      withPending([{ tool: 'memory.remember', args: { text: 'לומד הנדסת תעשייה וניהול באריאל' } }]),
    );
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(plain(out.text)).toContain('לשמור כעובדה עליך');
    expect(await facts.all(PRINCIPAL)).toEqual([]);
    const yes = out.buttons?.find((b) => b.id.startsWith('pa:') && b.id.endsWith(':ok'));
    expect(yes).toBeDefined();

    const tapped = await handleInbound(
      { kind: 'button', wamid: 'wamid.facts.tap', from: '972500000000', sentAtMs: NOW - 500, buttonId: yes!.id, forwarded: false },
      withPending([]),
    );
    if (tapped.action !== 'reply') throw new Error('expected a reply');
    expect(plain(tapped.text)).toContain('נשמר כעובדה עליך');
    expect(tapped.buttons ?? []).toEqual([]);
    expect((await facts.all(PRINCIPAL)).map((f) => f.text)).toEqual(['לומד הנדסת תעשייה וניהול באריאל']);
  });

  it('"no" on the card keeps nothing', async () => {
    const pending = new PendingActions(driver, () => NOW);
    const d = deps([{ tool: 'memory.remember', args: { text: 'עובד בהייטק' } }]);
    const out = await handleInbound(say('אני עובד בהייטק'), { ...d, services: { ...d.services!, pending } });
    if (out.action !== 'reply') throw new Error('expected a reply');
    const no = out.buttons!.find((b) => b.id.endsWith(':no'))!;
    const e = deps([]);
    await handleInbound(
      { kind: 'button', wamid: 'wamid.facts.no', from: '972500000000', sentAtMs: NOW - 500, buttonId: no.id, forwarded: false },
      { ...e, services: { ...e.services!, pending } },
    );
    expect(await facts.all(PRINCIPAL)).toEqual([]);
  });

  it('"תזכור עליי" keeps it at once, with Undo', async () => {
    const out = await handleInbound(say('תזכור עליי שאני צמחוני'), deps([{ tool: 'memory.remember', args: { text: 'אני צמחוני' } }]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.buttons?.some((b) => b.id.startsWith('undo:'))).toBe(true);
    expect(await facts.all(PRINCIPAL)).toHaveLength(1);
  });

  it('/forget alone keeps the facts', async () => {
    await facts.add(PRINCIPAL, 'אני גר ברחובות');
    await handleInbound(say('/forget'), deps([]));
    expect(await facts.all(PRINCIPAL)).toHaveLength(1);
  });
});
