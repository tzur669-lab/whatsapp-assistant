/**
 * "לא הבנת" capture (PLAN §6.23, ROADMAP block H part 16, 2026-10-07).
 *
 * What is kept is the latest exchange that reached a model, ordered by arrival,
 * encrypted, and only ever shown back to the user who asked for it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ExchangeLog, EXCHANGE_TTL_MS, MAX_MISSES } from '../../../src/core/exchanges.js';
import type { Exchange } from '../../../src/core/exchanges.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { he } from '../../../src/render/he.js';
import { missText } from '../../../src/render/misses.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-07T09:00:00Z');
const PRINCIPAL = 'p_misses';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const plain = (text: string) => stripIsolates(text);

const exchange = (user: string): Exchange => ({
  user,
  reply: `תשובה ל${user}`,
  outcome: 'ALLOW',
  intent: 'agent',
  groups: [],
  at: NOW,
});

describe('inbound sequence', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  const record = (wamid: string, at = NOW) =>
    repo.recordInbound({ wamid, principal: PRINCIPAL, receivedAt: at, sentAt: at, kind: 'text' });

  it('numbers each new message once, in arrival order, whatever the clock says', () => {
    expect(record('a')).toEqual({ status: 'fresh', mode: 'local' });
    expect(record('b')).toEqual({ status: 'fresh', mode: 'local' });
    expect(repo.inboundSeq('a')).toBe(1);
    expect(repo.inboundSeq('b')).toBe(2);
  });

  it('a duplicate consumes no number', () => {
    record('a');
    expect(record('a')).toEqual({ status: 'duplicate' });
    record('b');
    expect(repo.inboundSeq('b')).toBe(2);
  });

  it('keeps counting after the table is pruned empty', () => {
    record('a');
    record('b');
    repo.purgeInboundBefore(NOW + 1);
    record('c');
    expect(repo.inboundSeq('c')).toBe(3);
  });
});

describe('ExchangeLog', () => {
  let driver: TestSqlDriver;
  let now: number;
  let log: ExchangeLog;
  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    log = new ExchangeLog(driver, () => now, keyring);
  });
  afterEach(() => driver.close());

  it('keeps the newest message, not the one that finished last', async () => {
    await log.record(PRINCIPAL, '', 5, exchange('חדשה'));
    await log.record(PRINCIPAL, '', 4, exchange('ישנה שהסתיימה אחרונה'));
    expect(await log.capture(PRINCIPAL, '')).toMatchObject({ kind: 'saved', exchange: { user: 'חדשה' } });
  });

  it('an expired row never blocks a new write, even with a lower number', async () => {
    await log.record(PRINCIPAL, '', 9, exchange('ישנה'));
    now += EXCHANGE_TTL_MS + 1;
    await log.record(PRINCIPAL, '', 1, exchange('אחרי איפוס'));
    expect(await log.capture(PRINCIPAL, '')).toMatchObject({ exchange: { user: 'אחרי איפוס' } });
  });

  it('an expired exchange is not captured', async () => {
    await log.record(PRINCIPAL, '', 1, exchange('ישנה'));
    now += EXCHANGE_TTL_MS;
    expect(await log.capture(PRINCIPAL, '')).toEqual({ kind: 'none' });
  });

  it('keeps conversations apart', async () => {
    await log.record(PRINCIPAL, 'c1', 1, exchange('בשיחה אחת'));
    expect(await log.capture(PRINCIPAL, 'c2')).toEqual({ kind: 'none' });
  });

  it('stores ciphertext only', async () => {
    await log.record(PRINCIPAL, '', 1, exchange('סוד גלוי 4321'));
    await log.capture(PRINCIPAL, '');
    const dump = JSON.stringify([
      ...driver.exec('SELECT * FROM last_exchange'),
      ...driver.exec('SELECT * FROM misses'),
    ]);
    expect(dump).not.toContain('4321');
    expect(dump).toContain('enc.1.');
  });

  it('a row that no longer decrypts is dropped, not shown', async () => {
    await log.record(PRINCIPAL, '', 1, exchange('ישנה'));
    const rotated = new ExchangeLog(driver, () => now, () => parseKeyring({ TOKEN_ENC_KEY_V1: OTHER_KEY }));
    expect(await rotated.capture(PRINCIPAL, '')).toEqual({ kind: 'none' });
    expect(driver.exec('SELECT * FROM last_exchange')).toHaveLength(0);
  });

  it('keeps the newest 50 misses, newest first', async () => {
    for (let i = 0; i < MAX_MISSES + 2; i++) {
      now = NOW + i;
      await log.record(PRINCIPAL, '', i + 1, exchange(`בקשה ${i}`));
      await log.capture(PRINCIPAL, '');
    }
    expect(driver.exec('SELECT * FROM misses')).toHaveLength(MAX_MISSES);
    expect((await log.list(PRINCIPAL, 1))[0]?.user).toBe(`בקשה ${MAX_MISSES + 1}`);
  });

  it('forget drops the latest exchange and keeps the misses', async () => {
    await log.record(PRINCIPAL, '', 1, exchange('נשמרה'));
    await log.capture(PRINCIPAL, '');
    await log.record(PRINCIPAL, '', 2, exchange('אחרונה'));
    log.forget(PRINCIPAL);
    expect(await log.capture(PRINCIPAL, '')).toEqual({ kind: 'none' });
    expect(await log.list(PRINCIPAL)).toHaveLength(1);
  });
});

describe('"לא הבנת" through the pipeline', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let exchanges: ExchangeLog;
  let lock: AgentLock;
  let notes: NoteStore;
  let pending: PendingActions;
  let history: ConversationHistory;

  const deps = (steps: FakeStep[] = [], withAgent = true): PipelineDeps => {
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      notes,
      pending,
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      ...(withAgent
        ? {
            agent: {
              providers: [createFakeAgent(steps)],
              budget: new TokenBudget(() => NOW),
              history,
              lock,
            },
          }
        : {}),
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, exchanges, channel: 'app' };
  };

  let seq = 0;
  const say = (body: string, extra: Record<string, unknown> = {}): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.miss.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false, ...extra }) as InboundEvent;

  const send = async (body: string, d: PipelineDeps = deps()) => {
    const out = await handleInbound(say(body), d);
    if (out.action !== 'reply') throw new Error('expected a reply');
    return out;
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    exchanges = new ExchangeLog(driver, () => NOW, keyring);
    lock = new AgentLock(driver, () => NOW);
    notes = new NoteStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    history = new ConversationHistory(driver, () => NOW, keyring);
  });
  afterEach(() => driver.close());

  it('keeps a model turn, echoes it, and shows it in /misses, all privately', async () => {
    await send('מה שווי התיק שלי', deps([{ text: 'אין לי גישה לזה' }]));
    const saved = await send('לא הבנת!');
    expect(saved.private).toBe(true);
    expect(plain(saved.text)).toBe(plain(missText.saved('מה שווי התיק שלי')));

    const list = await send('/misses');
    expect(list.private).toBe(true);
    expect(plain(list.text)).toContain('בקשה: מה שווי התיק שלי');
    expect(plain(list.text)).toContain('תשובה: אין לי גישה לזה');
  });

  it('a failed turn is kept too', async () => {
    await send('בלה בלה', deps([], false));
    expect(plain((await send('לא הבנת')).text)).toContain('בלה בלה');
  });

  it('commands in between do not replace it', async () => {
    await send('תעשה משהו חכם', deps([{ text: 'לא יודע' }]));
    await send('/help');
    await send('/misses');
    expect(plain((await send('לא הבנת אותי')).text)).toContain('תעשה משהו חכם');
  });

  it('a "כן" to a confirmation does not replace the request it answered', async () => {
    notes.add(PRINCIPAL, 'פתק החניה');
    await send('תמחק את הפתק על החניה', deps([{ tool: 'notes.delete', args: { query_variants: ['החניה'] } }]));
    await send('כן');
    // The request was private (a note), so it is kept as a placeholder — but it
    // is the request, not the "כן".
    expect(plain((await send('לא הבנת')).text)).toContain(he.privatePlaceholder);
  });

  it('a correction with more words goes to the agent, not the capture', async () => {
    await send('תזכיר לי משהו', deps([{ text: 'מתי?' }]));
    const out = await send('לא הבנת, התכוונתי למחר', deps([{ text: 'הבנתי' }]));
    expect(plain(out.text)).toBe('הבנתי');
  });

  it('while a turn is still running: says so, and the busy reply is not kept', async () => {
    await send('בקשה ראשונה', deps([{ text: 'תשובה ראשונה' }]));
    lock.acquire(PRINCIPAL, 'someone-else');
    expect(plain((await send('בקשה שנייה')).text)).toBe(he.agentBusy);
    expect(plain((await send('לא הבנת')).text)).toBe(missText.stillRunning);
    lock.release(PRINCIPAL, 'someone-else');
    expect(plain((await send('לא הבנת')).text)).toContain('בקשה ראשונה');
  });

  it('a voice note is kept as the placeholder, never the transcript (invariant 13)', async () => {
    const audio = {
      kind: 'audio',
      wamid: `wamid.miss.${++seq}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      mediaId: 'MEDIA-1',
      mimeType: 'audio/ogg',
      voiceNote: true,
      forwarded: false,
    } as InboundEvent;
    await handleInbound(audio, {
      ...deps([{ text: 'שמעתי ועניתי' }]),
      transcribe: async () => ({ status: 'ok', text: 'מילים סודיות שנאמרו', confidence: 'high', language: 'he' }),
    });
    const saved = await send('לא הבנת');
    expect(plain(saved.text)).toContain(he.voicePlaceholder);
    expect(plain((await send('/misses')).text)).not.toContain('סודיות');
  });

  it('nothing to keep says so', async () => {
    expect(plain((await send('לא הבנת')).text)).toBe(missText.none);
  });

  it('/forget drops the latest exchange', async () => {
    await send('משהו', deps([{ text: 'משהו אחר' }]));
    await send('/forget');
    expect(plain((await send('לא הבנת')).text)).toBe(missText.none);
  });

  it('forwarded text never runs the capture', async () => {
    await send('בקשה', deps([{ text: 'תשובה' }]));
    const out = await handleInbound(say('לא הבנת', { forwarded: true }), deps([{ text: 'קראתי' }]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(plain(out.text)).toBe('קראתי');
  });

  it('the agent is never handed the capture store', () => {
    const agent = deps().services?.agent as Record<string, unknown> | undefined;
    expect(Object.keys(agent ?? {})).not.toContain('exchanges');
  });
});
