/**
 * The learning journal (block K, K1, PLAN §6.31, 2026-10-14).
 *
 * Off by default; collects nothing until its notice was delivered; one row per
 * rephrase pair; never plaintext; bounded; forgotten on request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ExchangeLog, EXCHANGE_TTL_MS } from '../../../src/core/exchanges.js';
import {
  KIND_SINCE,
  LEARN_EVENT_TTL_MS,
  LEARN_NOTICE_VERSION,
  LearnStore,
  MAX_LEARN_EVENTS,
  MAX_LEARN_TEXT_CHARS,
  REPHRASE_WINDOW_MS,
  weekStartOf,
} from '../../../src/core/learn-store.js';
import type { LearnFeature, LearnTurn } from '../../../src/core/learn-store.js';
import { LEARN_FEATURE_LINES, learnText } from '../../../src/render/learn.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { PendingActions, buttonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { decryptToken, parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { matchCommand } from '../../../src/core/router.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-14T09:00:00Z');
const PRINCIPAL = 'p_learn';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const plain = (text: string) => stripIsolates(text);

const turn = (user: string): LearnTurn => ({ user, reply: `תשובה ל${user}`, outcome: 'CLARIFY', intent: 'agent' });

/** On, and its notice delivered through the app's ack. */
function startLearning(learn: LearnStore, seq = 1): void {
  expect(learn.turnOn()).toBe('notice');
  learn.noticeQueued(LEARN_NOTICE_VERSION, seq);
  learn.acked([seq]);
}

describe('LearnStore', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let now: number;
  let learn: LearnStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = NOW;
    learn = new LearnStore(driver, repo, () => now, keyring);
  });
  afterEach(() => driver.close());

  const events = () => driver.exec('SELECT * FROM learn_events');

  describe('disclosure', () => {
    it('is off by default and collects nothing', async () => {
      expect(learn.state()).toEqual({ on: false, seen: null, sent: null, since: null });
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 3);
      learn.bumpWeek(PRINCIPAL, 'messages');
      expect(await learn.sealMiss(PRINCIPAL, turn('א'))).toBeNull();
      expect(events()).toHaveLength(0);
      expect(driver.exec('SELECT * FROM learn_weeks')).toHaveLength(0);
    });

    it('on, but nothing is collected until the notice row is acked', () => {
      learn.turnOn();
      learn.noticeQueued(LEARN_NOTICE_VERSION, 7);
      expect(learn.collectable('miss')).toBe(false);
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 3);
      expect(events()).toHaveLength(0);

      learn.acked([6, 8]); // other rows
      expect(learn.collectable('miss')).toBe(false);

      now += 5_000;
      learn.acked([7]);
      expect(learn.collectable('miss')).toBe(true);
      expect(learn.state()).toMatchObject({ seen: LEARN_NOTICE_VERSION, sent: null, since: now });
    });

    it('a repeated ack, or an ack of a replaced notice, changes nothing', () => {
      learn.turnOn();
      learn.noticeQueued(LEARN_NOTICE_VERSION, 7);
      learn.noticeQueued(LEARN_NOTICE_VERSION, 9); // `/learn on` again replaced it
      learn.acked([7]);
      expect(learn.collectable('miss')).toBe(false);
      learn.acked([9]);
      const since = learn.state().since;
      now += 60_000;
      learn.acked([9]);
      expect(learn.state().since).toBe(since);
    });

    it('seen never goes down', () => {
      startLearning(learn);
      learn.noticeDelivered(0);
      expect(learn.state().seen).toBe(LEARN_NOTICE_VERSION);
    });

    it('an expired notice is queued again by the tick, once; a replaced one is not cleared', () => {
      learn.turnOn();
      learn.noticeQueued(LEARN_NOTICE_VERSION, 7);
      expect(learn.staleNotice()).toBeNull(); // outstanding
      learn.expired([3]);
      expect(learn.state().sent).toEqual({ version: LEARN_NOTICE_VERSION, seq: 7 });
      learn.expired([7]);
      expect(learn.state().sent).toBeNull();
      expect(learn.staleNotice()).toBe(LEARN_NOTICE_VERSION);
      learn.noticeQueued(LEARN_NOTICE_VERSION, 11);
      expect(learn.staleNotice()).toBeNull();
    });

    it('a repeat /learn on: current → already; waiting → the notice again, and the start is kept', () => {
      learn.turnOn();
      learn.noticeQueued(LEARN_NOTICE_VERSION, 1);
      expect(learn.turnOn()).toBe('notice'); // still outstanding
      learn.noticeQueued(LEARN_NOTICE_VERSION, 2);
      learn.acked([2]);
      const since = learn.state().since;
      now += 60_000;
      expect(learn.turnOn()).toBe('already');
      expect(learn.state().since).toBe(since);
    });

    it('/learn off stops collecting and keeps the data; on again waits for a new delivery', () => {
      startLearning(learn);
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 3);
      expect(learn.turnOff()).toBe(true);
      expect(learn.turnOff()).toBe(false);
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 3);
      expect(events()).toHaveLength(1);
      learn.turnOn();
      expect(learn.collectable('undo')).toBe(false);
      learn.acked([1]); // the old seq: inert
      expect(learn.collectable('undo')).toBe(false);
    });

    it('nothing before the start shapes anything: startOf is the delivery', () => {
      learn.turnOn();
      learn.noticeQueued(LEARN_NOTICE_VERSION, 1);
      expect(learn.startOf('first_message')).toBeNull();
      now += 30_000;
      learn.acked([1]);
      expect(learn.startOf('first_message')).toBe(now);
      expect(learn.startOf('weeks')).toBe(now);
    });
  });

  describe('events', () => {
    beforeEach(() => startLearning(learn));

    it('a miss is ciphertext, reported, bound to its row', async () => {
      const sealed = await learn.sealMiss(PRINCIPAL, turn('סוד גלוי 4321'));
      learn.insertSealed(sealed!);
      const row = events()[0]!;
      expect(row['kind']).toBe('miss');
      expect(row['confidence']).toBe('reported');
      expect(JSON.stringify(row)).not.toContain('4321');
      const opened = JSON.parse(
        await decryptToken(String(row['ciphertext']), keyring(), { provider: 'learn', account: `${PRINCIPAL}:${String(row['id'])}` }),
      ) as { failed: LearnTurn };
      expect(opened.failed.user).toBe('סוד גלוי 4321');
    });

    it('a rephrase pair is one heuristic row holding both sides, cut to the cap', async () => {
      const long = 'א'.repeat(MAX_LEARN_TEXT_CHARS + 50);
      const sealed = await learn.sealRephrase(PRINCIPAL, turn(long), turn('ב'), { gapSeconds: 20.4, tools: ['reminders.list', 'not.a.tool'] });
      learn.insertSealed(sealed!);
      const row = events()[0]!;
      expect(row['confidence']).toBe('heuristic');
      expect(JSON.parse(String(row['meta']))).toEqual({ gap_s: 20, tools: ['reminders.list'] });
      const opened = JSON.parse(
        await decryptToken(String(row['ciphertext']), keyring(), { provider: 'learn', account: `${PRINCIPAL}:${String(row['id'])}` }),
      ) as { failed: LearnTurn; fixed: LearnTurn };
      expect(opened.failed.user).toHaveLength(MAX_LEARN_TEXT_CHARS);
      expect(opened.fixed.user).toBe('ב');
    });

    it('the database refuses a confidence outside the closed set', () => {
      expect(() =>
        driver.exec(
          "INSERT INTO learn_events (id, principal, kind, confidence, meta, created_at) VALUES ('x', 'p', 'miss', 'guess', '{}', 1)",
        ),
      ).toThrow();
    });

    it('taps carry a tool from the registry and whole seconds, nothing else', () => {
      learn.addTap(PRINCIPAL, 'confirm_no', 'reminders.cancel', 12.6);
      learn.addTap(PRINCIPAL, 'undo', 'made.up', 1);
      learn.addLeave(PRINCIPAL, 25, true);
      const rows = events();
      expect(rows.map((row) => [row['kind'], row['ciphertext'], JSON.parse(String(row['meta']))])).toEqual(
        expect.arrayContaining([
          ['confirm_no', null, { tool: 'reminders.cancel', seconds: 13 }],
          ['leave', null, { minutes: 25, stated: 1 }],
        ]),
      );
      expect(rows).toHaveLength(2);
    });

    it('keeps the newest 200, and a trimmed pair goes whole', async () => {
      for (let i = 0; i < MAX_LEARN_EVENTS + 3; i++) {
        now = NOW + i;
        if (i % 2 === 0) learn.insertSealed((await learn.sealRephrase(PRINCIPAL, turn(`a${i}`), turn(`b${i}`), { gapSeconds: 1, tools: [] }))!);
        else learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 1);
      }
      expect(events()).toHaveLength(MAX_LEARN_EVENTS);
      for (const row of events().filter((r) => r['kind'] === 'rephrase')) {
        const opened = JSON.parse(
          await decryptToken(String(row['ciphertext']), keyring(), { provider: 'learn', account: `${PRINCIPAL}:${String(row['id'])}` }),
        ) as { failed: LearnTurn; fixed: LearnTurn };
        expect(opened.fixed.user.slice(1)).toBe(opened.failed.user.slice(1));
      }
    });

    it('purges events after 60 days and weeks after 26', () => {
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 1);
      learn.bumpWeek(PRINCIPAL, 'messages');
      now += LEARN_EVENT_TTL_MS;
      expect(learn.purge().events).toBe(1);
      now = NOW + 27 * 7 * 86_400_000;
      expect(learn.purge().weeks).toBe(1);
    });

    it('/learn forget deletes the journal and the counters, keeps the misses, and restarts now', async () => {
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 1);
      learn.bumpWeek(PRINCIPAL, 'messages');
      driver.exec("INSERT INTO misses (id, principal, ciphertext, created_at) VALUES ('m1', ?, 'x', ?)", PRINCIPAL, now);
      now += 1_000;
      expect(learn.forget(PRINCIPAL)).toEqual({ events: 1, weeks: 1, proposals: 0 });
      expect(driver.exec('SELECT * FROM misses')).toHaveLength(1);
      expect(learn.state().since).toBe(now);
      expect(learn.status(PRINCIPAL).counts.undo).toBe(0);
    });

    it('counts per kind and the oldest entry for /learn', () => {
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 1);
      now += 1_000;
      learn.addLeave(PRINCIPAL, 20, false);
      const status = learn.status(PRINCIPAL);
      expect(status.counts).toMatchObject({ undo: 1, leave: 1, miss: 0 });
      expect(status.oldest).toBe(NOW);
    });
  });
});

describe('weekStartOf', () => {
  it('is the Sunday of the local week', () => {
    expect(weekStartOf(Date.parse('2026-10-14T09:00:00Z'))).toBe('2026-10-11'); // Wednesday
    expect(weekStartOf(Date.parse('2026-10-10T21:30:00Z'))).toBe('2026-10-11'); // Sunday 00:30 local
    expect(weekStartOf(Date.parse('2026-10-10T20:30:00Z'))).toBe('2026-10-04'); // Saturday 23:30 local
  });

  it('holds across the fall-back on 2026-10-25', () => {
    expect(weekStartOf(Date.parse('2026-10-24T20:30:00Z'))).toBe('2026-10-18'); // Sat 23:30 IDT
    expect(weekStartOf(Date.parse('2026-10-24T23:30:00Z'))).toBe('2026-10-25'); // Sun 01:30 IST, after the fold
    expect(weekStartOf(Date.parse('2026-10-31T21:30:00Z'))).toBe('2026-10-25'); // Sat 23:30 IST
  });
});

describe('the notice', () => {
  it('names every kind up to the current version', () => {
    const text = plain(learnText.notice(null, false));
    for (const feature of Object.keys(KIND_SINCE) as LearnFeature[]) {
      if (KIND_SINCE[feature] <= LEARN_NOTICE_VERSION) expect(text).toContain(LEARN_FEATURE_LINES[feature]);
    }
  });

  it('marks nothing new for a first notice', () => {
    expect(plain(learnText.notice(null, false))).not.toContain('(חדש)');
  });
});

describe('/learn through the pipeline', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let exchanges: ExchangeLog;
  let learn: LearnStore;
  let pending: PendingActions;
  let now: number;

  const deps = (steps: FakeStep[] = []): PipelineDeps => {
    const services: Services = {
      reminders: new ReminderStore(driver, () => now),
      notes: new NoteStore(driver, () => now),
      pending,
      questions: new OpenQuestions(driver, () => now),
      deferred: new UndoActions(driver, () => now),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: {
        providers: [createFakeAgent(steps)],
        budget: new TokenBudget(() => now),
        history: new ConversationHistory(driver, () => now, keyring),
        lock: new AgentLock(driver, () => now),
      },
    };
    return { repo, log: createFakeLogger(), now: () => now, principal: PRINCIPAL, services, exchanges, learn, channel: 'app' };
  };

  let seq = 0;
  const say = (body: string, extra: Record<string, unknown> = {}): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.learn.${++seq}`, from: '972500000000', sentAtMs: now - 1_000, text: body, forwarded: false, ...extra }) as InboundEvent;

  const send = async (body: string, d: PipelineDeps = deps(), extra: Record<string, unknown> = {}) => {
    const out = await handleInbound(say(body, extra), d);
    if (out.action !== 'reply') throw new Error('expected a reply');
    return out;
  };

  const kinds = () => driver.exec('SELECT kind FROM learn_events ORDER BY created_at').map((row) => row['kind']);
  const week = () => driver.exec('SELECT messages, misses, rephrases FROM learn_weeks')[0];

  /** A failed turn, then the same request worded so a tool runs. */
  const failThenFix = async (gapMs = 20_000, extra: Record<string, unknown> = {}) => {
    await send('תזכורות?', deps([{ text: 'לא בטוח למה הכוונה' }]));
    now += gapMs;
    await send('מה התזכורות שלי', deps([{ tool: 'reminders.list', args: {} }, { text: 'אין תזכורות' }]), extra);
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = NOW;
    exchanges = new ExchangeLog(driver, () => now, keyring);
    learn = new LearnStore(driver, repo, () => now, keyring);
    pending = new PendingActions(driver, () => now);
  });
  afterEach(() => driver.close());

  it('the router reads /learn and its actions only', () => {
    expect(matchCommand('/learn')).toEqual({ kind: 'learn', action: 'status' });
    expect(matchCommand('/learn on')).toEqual({ kind: 'learn', action: 'on' });
    expect(matchCommand('/LEARN Forget')).toEqual({ kind: 'learn', action: 'forget' });
    expect(matchCommand('/learn everything')).toBeNull();
  });

  it('/learn on answers with the notice and marks it as the notice', async () => {
    const out = await send('/learn on');
    expect(out.learnNotice).toBe(LEARN_NOTICE_VERSION);
    expect(plain(out.text)).toBe(plain(learnText.notice(null, false)));
    expect(plain((await send('/learn')).text)).toContain('מחכה');
  });

  it('a second /learn on once delivered says it is already on, and sends nothing', async () => {
    startLearning(learn);
    const out = await send('/learn on');
    expect(out.learnNotice).toBeUndefined();
    expect(plain(out.text)).toBe(learnText.alreadyOn);
  });

  it('/learn off, /learn forget', async () => {
    startLearning(learn);
    expect(plain((await send('/learn off')).text)).toBe(plain(learnText.off));
    expect(plain((await send('/learn forget')).text)).toBe(plain(learnText.forgotten({ events: 0, weeks: 0, proposals: 0 })));
  });

  it('a failed request rephrased within 3 minutes is one rephrase row, counted', async () => {
    startLearning(learn);
    await failThenFix();
    expect(kinds()).toEqual(['rephrase']);
    expect(week()).toEqual({ messages: 2, misses: 0, rephrases: 1 });
  });

  it('nothing while the notice is undelivered: no rows, no counters', async () => {
    learn.turnOn();
    learn.noticeQueued(LEARN_NOTICE_VERSION, 1);
    await failThenFix();
    expect(kinds()).toEqual([]);
    expect(week()).toBeUndefined();
  });

  it('three minutes or more apart is not a rephrase', async () => {
    startLearning(learn);
    await failThenFix(REPHRASE_WINDOW_MS);
    expect(kinds()).toEqual([]);
  });

  it('shared or forwarded text is never a rephrase', async () => {
    startLearning(learn);
    await failThenFix(20_000, { forwarded: true });
    expect(kinds()).toEqual([]);
  });

  it('two understood turns are not a rephrase', async () => {
    startLearning(learn);
    await send('מה התזכורות שלי', deps([{ tool: 'reminders.list', args: {} }, { text: 'אין' }]));
    now += 10_000;
    await send('ומה עוד', deps([{ tool: 'reminders.list', args: {} }, { text: 'אין' }]));
    expect(kinds()).toEqual([]);
  });

  it('a failed turn before learning started is never paired', async () => {
    await send('תזכורות?', deps([{ text: 'לא בטוח' }]));
    now += 5_000;
    startLearning(learn);
    now += 5_000;
    await send('מה התזכורות שלי', deps([{ tool: 'reminders.list', args: {} }, { text: 'אין' }]));
    expect(kinds()).toEqual([]);
  });

  it('"לא הבנת" copies the miss into the journal and counts it', async () => {
    startLearning(learn);
    await send('תעשה משהו חכם', deps([{ text: 'לא יודע' }]));
    await send('לא הבנת');
    expect(kinds()).toEqual(['miss']);
    expect(week()).toMatchObject({ misses: 1 });
  });

  it('a declined confirmation is a confirm_no with its tool, no text', async () => {
    startLearning(learn);
    const action = pending.create({ tool: 'reminders.cancel', input: { id: 'x' }, summary: 's', tier: 2, principal: PRINCIPAL });
    now += 8_000;
    const out = await handleInbound(
      { kind: 'button', wamid: 'wamid.learn.btn', from: '972500000000', sentAtMs: now - 500, buttonId: buttonId('pa', action.id, action.nonce, 'no'), forwarded: false },
      deps(),
    );
    expect(out.action).toBe('reply');
    const row = driver.exec('SELECT kind, ciphertext, meta FROM learn_events')[0];
    expect(row).toEqual({ kind: 'confirm_no', ciphertext: null, meta: JSON.stringify({ tool: 'reminders.cancel', seconds: 8 }) });
  });

  it('"no" on an offered fact is not a refusal (2026-10-14)', async () => {
    startLearning(learn);
    const action = pending.create({ tool: 'memory.remember', input: { text: 'לומד באריאל' }, summary: 's', tier: 1, principal: PRINCIPAL });
    await handleInbound(
      { kind: 'button', wamid: 'wamid.learn.fact', from: '972500000000', sentAtMs: now - 500, buttonId: buttonId('pa', action.id, action.nonce, 'no'), forwarded: false },
      deps(),
    );
    expect(kinds()).toEqual([]);
  });

  it('commands do not count as messages', async () => {
    startLearning(learn);
    await send('/learn');
    await send('/help');
    expect(week()).toBeUndefined();
  });

  it('the exchange keeps whether it was understood, and an old row without it is never a failure', async () => {
    startLearning(learn);
    // A row written before K1: no `understood` field.
    await exchanges.record(PRINCIPAL, '', 0, { user: 'ישנה', reply: 'ר', outcome: 'CLARIFY', intent: null, groups: [], at: now });
    now += 5_000;
    await send('מה התזכורות שלי', deps([{ tool: 'reminders.list', args: {} }, { text: 'אין' }]));
    expect(kinds()).toEqual([]);
    expect((await exchanges.latest(PRINCIPAL, ''))?.exchange.understood).toBe(true);
    expect(EXCHANGE_TTL_MS).toBeGreaterThan(REPHRASE_WINDOW_MS);
  });
});
