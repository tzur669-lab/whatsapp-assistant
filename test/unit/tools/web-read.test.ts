/**
 * `web.read` end to end through the pipeline (block J, J3): offered only for a
 * message with exactly one https link; code takes the link; the page taints
 * the turn and what follows; a shared link never reaches a smart model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { webRead } from '../../../src/tools/web-read.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_web';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const LINK = 'https://news.example.com/article/1';
const PAGE = '<html><head><title>כותרת</title></head><body><nav>תפריט</nav><p>הפסקה הראשונה. התקשרו 050-1234567</p></body></html>';
const READ: FakeStep = { tool: 'web.read', args: {} };
const TOMORROW_AT_EIGHT_PM = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 20, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

describe('web.read', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let history: ConversationHistory;
  let base: Omit<Services, 'nlu'>;
  let fetched: string[];

  /** A fake page server and extractor: no network. */
  const fetchImpl = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  const pageText = async (html: string) =>
    html
      .replace(/<nav>.*?<\/nav>/g, '')
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');

  const deps = (agent: FakeAgent, options: { smart?: FakeAgent; parser?: unknown[] } = {}): PipelineDeps => ({
    repo,
    log: createFakeLogger(),
    now: () => NOW,
    principal: PRINCIPAL,
    channel: 'app',
    services: {
      ...base,
      nlu: [createFakeNlu(options.parser ?? [draft('unsupported')])],
      agent: {
        ...base.agent!,
        providers: [agent],
        ...(options.smart ? { smartProviders: [options.smart] } : {}),
      },
    },
  });

  let seq = 0;
  const text = (body: string, options: { forwarded?: boolean; mode?: 'smart' | 'local'; conversation?: string } = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:web.${++seq}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      text: body,
      forwarded: options.forwarded === true,
      conversationId: options.conversation ?? 'conv-web',
      mode: options.mode ?? 'local',
    }) as InboundEvent;
  const offered = (agent: FakeAgent, call = 0) => agent.tools[call]!.map((tool) => tool.function.name);

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    fetched = [];
    base = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      fetchImpl,
      pageText,
      agent: { providers: [], budget: new TokenBudget(() => NOW), history, lock: new AgentLock(driver, () => NOW) },
    };
  });
  afterEach(() => driver.close());

  it('reads the linked page for the model, scrubbed, and keeps the turn private', async () => {
    const agent = createFakeAgent([READ, { text: 'הכתבה מספרת על פסקה ראשונה.' }], QWEN);
    const out = await handleInbound(text(`תסכם לי את זה ${LINK}`), deps(agent));
    expect(offered(agent)).toContain('web__read');
    expect(fetched).toEqual([LINK]);
    expect(out).toMatchObject({ action: 'reply', text: 'הכתבה מספרת על פסקה ראשונה.', private: true });
    const seen = seenByModel(agent);
    expect(seen).toContain('הפסקה הראשונה');
    expect(seen).not.toContain('תפריט');
    // `scrubForModel`: no phone number reaches the model.
    expect(seen).not.toContain('050-1234567');
    expect((await history.recent(PRINCIPAL, 'conv-web')).at(-1)?.tainted).toBe(true);
  });

  it('is not offered without a link, or with two', async () => {
    const none = createFakeAgent([{ text: 'שלום' }], QWEN);
    await handleInbound(text('מה נשמע'), deps(none));
    expect(offered(none)).not.toContain('web__read');
    const two = createFakeAgent([{ text: 'שלום' }], QWEN);
    await handleInbound(text(`${LINK} וגם https://other.example.com/x`), deps(two));
    expect(offered(two)).not.toContain('web__read');
  });

  it('rides along when the words name another group', async () => {
    const agent = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(`תזכיר לי מחר לקרוא את ${LINK}`), deps(agent));
    expect(offered(agent)).toContain('web__read');
    expect(offered(agent)).toContain('reminders__create');
  });

  it('a write after the page, on the next message, confirms', async () => {
    await handleInbound(text(`מה כתוב פה ${LINK}`), deps(createFakeAgent([READ, { text: 'יש שם הזמנה לכנס.' }], QWEN)));
    const out = await handleInbound(
      text('תזכיר לי מחר בשמונה בערב על הכנס'),
      deps(createFakeAgent([{ tool: 'reminders.create', args: { text: 'הכנס', ...TOMORROW_AT_EIGHT_PM } }], QWEN)),
    );
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.buttons?.length ?? 0).toBeGreaterThan(0);
    expect(driver.exec('SELECT COUNT(*) AS n FROM reminders')[0]?.['n']).toBe(0);
  });

  it('a forwarded link in a smart conversation runs local, tainted, never on Gemini', async () => {
    const gemini = createFakeAgent([], SMART_MODELS[0]!.id, 500, 'smart');
    const qwen = createFakeAgent([READ, { text: 'סיכום' }], QWEN);
    const out = await handleInbound(text(`תראה ${LINK}`, { forwarded: true, mode: 'smart', conversation: 'conv-smart-web' }), deps(qwen, { smart: gemini }));
    expect(gemini.calls).toHaveLength(0);
    expect(fetched).toEqual([LINK]);
    expect(out).toMatchObject({ private: true });
  });
});

describe('web.read execute', () => {
  const ctx = (userText: string, fetchImpl?: typeof fetch): ToolContext =>
    ({
      principal: 'p',
      nowMs: NOW,
      lang: 'he',
      log: createFakeLogger(),
      userText,
      ...(fetchImpl ? { fetchImpl } : {}),
      pageText: async () => 'טקסט',
    }) as unknown as ToolContext;
  const never = (async () => {
    throw new Error('must not fetch');
  }) as typeof fetch;

  it('takes the link from the words, not from the model', () => {
    expect(webRead.resolve({}, ctx(`קרא ${LINK}`))).toEqual({ kind: 'ready', input: { url: LINK } });
    expect(webRead.resolve({}, ctx('בלי קישור'))).toEqual({ kind: 'ready', input: { url: null } });
    expect(() => webRead.resolve({ url: 'https://evil.example.com' }, ctx(`קרא ${LINK}`))).toThrow();
  });

  it('answers in fixed words when there is no link or it is blocked, and never fetches', async () => {
    expect((await webRead.execute({ url: null }, ctx('', never))).text).toBe('לא מצאתי בהודעה קישור אחד לקריאה.');
    expect((await webRead.execute({ url: 'https://localhost/x' }, ctx('', never))).text).toContain('אי אפשר לקרוא');
  });

  it('a page is tainting, headed by its host', async () => {
    const ok = (async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const result = await webRead.execute({ url: LINK }, ctx('', ok));
    expect(result.tainting).toBe(true);
    expect(stripIsolates(result.text)).toBe('מהעמוד news.example.com:\nטקסט');
  });
});
