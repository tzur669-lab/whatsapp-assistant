/**
 * Mail follow-ups (block L, L2): the store, the tick and the notice buttons.
 *
 * The rules under test: the tick reads first and moves a row together with
 * its notice, in one transaction — a throw inside it leaves neither; two ticks
 * move a row once; Gmail unreachable is one "could not check" a day, never "no
 * reply"; a tap writes the row and its card together, and a re-tap replaces a
 * live card rather than adding one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { FollowUpStore, FOLLOWUP_TAP_MS, MAX_FOLLOWUP_ATTEMPTS } from '../../../src/tools/followup-store.js';
import { checkFollowUps } from '../../../src/core/followup-tick.js';
import type { FollowUpNotice, ThreadReader } from '../../../src/core/followup-tick.js';
import { PendingActions, parseButtonId } from '../../../src/confirm/pending.js';
import { GmailClient } from '../../../src/google/gmail.js';
import type { GoogleResult } from '../../../src/google/api.js';
import type { ThreadMessage } from '../../../src/google/gmail.js';
import { namesFollowUp, mailFollowUp, toLineOf } from '../../../src/tools/followup.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { selectTools } from '../../../src/agent/tool-groups.js';

const NOW = Date.UTC(2026, 9, 15, 7, 0);
const ME = 'p_me0000000000';
const OTHER = 'p_other0000000';
const SENT_AT = NOW - 2 * 24 * 60 * 60 * 1000;

let driver: TestSqlDriver;
let store: FollowUpStore;
let pending: PendingActions;
let now = NOW;

beforeEach(() => {
  now = NOW;
  driver = new TestSqlDriver();
  new Repository(driver).migrate(MIGRATIONS);
  store = new FollowUpStore(driver, () => now);
  pending = new PendingActions(driver, () => now);
});
afterEach(() => driver.close());

function create(overrides: Partial<Parameters<FollowUpStore['create']>[0]> = {}): string {
  const made = store.create({
    principal: ME,
    threadId: 'thread1',
    sentId: 'sent1',
    sentMessageId: '<m1@example.com>',
    sentAt: SENT_AT,
    subject: 'הצעת מחיר',
    toHeader: 'Dana <dana@example.com>',
    dueAt: NOW - 60_000,
    ...overrides,
  });
  if (!made.ok) throw new Error(made.reason);
  return made.id;
}

const statusOf = (id: string) => String(driver.exec('SELECT status FROM mail_followups WHERE id = ?', id)[0]?.['status']);

/** A thread holding the sent mail and, optionally, more. */
function thread(...more: Partial<ThreadMessage>[]): ThreadMessage[] {
  const base: ThreadMessage = {
    id: 'sent1',
    labelIds: ['SENT'],
    internalDate: SENT_AT,
    fromLocal: 'me',
    autoSubmitted: null,
    precedence: null,
    contentType: null,
    listId: false,
    failedRecipients: false,
  };
  return [base, ...more.map((m, i) => ({ ...base, id: `r${i}`, labelIds: ['INBOX'], internalDate: SENT_AT + 1000, fromLocal: 'dana', ...m }))];
}

function reader(result: GoogleResult<ThreadMessage[]>): ThreadReader & { calls: number } {
  return {
    calls: 0,
    async thread() {
      this.calls++;
      return result;
    },
  };
}

/** The notices, written to a real table inside the transaction, so a rollback removes them. */
function outbox() {
  driver.exec('CREATE TABLE IF NOT EXISTS test_notices (text TEXT, buttons TEXT)');
  return {
    notify(notice: FollowUpNotice) {
      driver.exec('INSERT INTO test_notices VALUES (?, ?)', notice.text, JSON.stringify(notice.buttons ?? []));
    },
    rows: () => driver.exec('SELECT * FROM test_notices').map((r) => ({ text: String(r['text']), buttons: JSON.parse(String(r['buttons'])) as { id: string; title: string }[] })),
  };
}

const tick = (gmail: ThreadReader | null, notify: (n: FollowUpNotice) => void) =>
  checkFollowUps({ principal: ME, store, gmail, notify, day: '2026-10-15' });

describe('FollowUpStore.create', () => {
  it('refuses a second follow-up of the same sent mail while one waits', () => {
    create();
    expect(store.create({ principal: ME, threadId: 't', sentId: 'sent1', sentMessageId: null, sentAt: SENT_AT, subject: 's', toHeader: null, dueAt: NOW })).toEqual({ ok: false, reason: 'exists' });
  });

  it('caps the active follow-ups at 20', () => {
    for (let i = 0; i < 20; i++) create({ sentId: `s${i}` });
    expect(store.create({ principal: ME, threadId: 't', sentId: 'x', sentMessageId: null, sentAt: SENT_AT, subject: 's', toHeader: null, dueAt: NOW })).toEqual({ ok: false, reason: 'full' });
  });
});

describe('checkFollowUps (the tick)', () => {
  it('nothing due: no Gmail call', async () => {
    create({ dueAt: NOW + 60_000 });
    const gmail = reader({ ok: true, value: thread() });
    await tick(gmail, outbox().notify);
    expect(gmail.calls).toBe(0);
  });

  it('a reply in the thread settles the follow-up silently', async () => {
    const id = create();
    const box = outbox();
    await tick(reader({ ok: true, value: thread({}) }), box.notify);
    expect(statusOf(id)).toBe('answered');
    expect(box.rows()).toEqual([]);
  });

  it('no reply by the deadline: one notice with a draft and a dismiss button', async () => {
    const id = create();
    const box = outbox();
    await tick(reader({ ok: true, value: thread() }), box.notify);
    expect(statusOf(id)).toBe('notified');
    const [notice] = box.rows();
    expect(notice!.text).toContain('לא ענו');
    expect(notice!.buttons.map((b) => parseButtonId(b.id)?.kind)).toEqual(['fu', 'fu']);
  });

  it('a bounce and a "maybe" are notices; the maybe never says it failed', async () => {
    const bounced = create();
    const maybe = create({ sentId: 'sent2', threadId: 'thread2' });
    const box = outbox();
    const gmail: ThreadReader = {
      async thread(id) {
        return id === 'thread1'
          ? { ok: true, value: thread({ failedRecipients: true }) }
          : { ok: true, value: [{ ...thread()[0]!, id: 'sent2' }, { ...thread({ fromLocal: 'postmaster' })[1]! }] };
      },
    };
    await tick(gmail, box.notify);
    expect(statusOf(bounced)).toBe('bounced');
    expect(statusOf(maybe)).toBe('unsure');
    const texts = box.rows().map((r) => r.text);
    expect(texts.some((t) => t.includes('לא נמסר'))).toBe(true);
    expect(texts.some((t) => t.includes('ייתכן'))).toBe(true);
  });

  it('a thread Gmail no longer has is unsure, never "no reply"', async () => {
    const id = create();
    const box = outbox();
    await tick(reader({ ok: false, error: { code: 'not_found' } }), box.notify);
    expect(statusOf(id)).toBe('unsure');
    expect(box.rows()[0]!.text).toContain('לא הצלחתי לבדוק');
  });

  it('three Gmail failures in a row: unsure; fewer: still open', async () => {
    const id = create();
    const box = outbox();
    const failing = reader({ ok: false, error: { code: 'provider_error', status: 503 } });
    for (let i = 1; i < MAX_FOLLOWUP_ATTEMPTS; i++) {
      await tick(failing, box.notify);
      expect(statusOf(id)).toBe('open');
    }
    await tick(failing, box.notify);
    expect(statusOf(id)).toBe('unsure');
    expect(box.rows()).toHaveLength(1);
  });

  it('Gmail not connected: one "could not check" a day, whatever the ticks', async () => {
    const id = create();
    const box = outbox();
    await tick(null, box.notify);
    await tick(null, box.notify);
    await tick(reader({ ok: false, error: { code: 'disconnected' } }), box.notify);
    expect(statusOf(id)).toBe('open');
    expect(box.rows()).toHaveLength(1);
    expect(box.rows()[0]!.text).toContain('לא הייתה גישה');
  });

  it('a throw inside the settling transaction leaves neither the move nor the notice', async () => {
    const id = create();
    const box = outbox();
    await expect(
      tick(reader({ ok: true, value: thread() }), (notice) => {
        box.notify(notice);
        throw new Error('crash after the notice row');
      }),
    ).rejects.toThrow();
    expect(statusOf(id)).toBe('open');
    expect(box.rows()).toEqual([]);
    // The next tick sends it, once.
    await tick(reader({ ok: true, value: thread() }), box.notify);
    expect(statusOf(id)).toBe('notified');
    expect(box.rows()).toHaveLength(1);
  });

  it('two interleaved ticks move the row once and queue one notice', async () => {
    const id = create();
    const box = outbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ThreadReader = {
      async thread() {
        await gate;
        return { ok: true, value: thread() };
      },
    };
    const first = tick(slow, box.notify);
    const second = tick(slow, box.notify);
    release();
    await Promise.all([first, second]);
    expect(statusOf(id)).toBe('notified');
    expect(box.rows()).toHaveLength(1);
  });

  it('a follow-up cancelled while its thread was being read sends nothing', async () => {
    const id = create();
    const box = outbox();
    const cancelling: ThreadReader = {
      async thread() {
        store.cancel(ME, id);
        return { ok: true, value: thread() };
      },
    };
    await tick(cancelling, box.notify);
    expect(statusOf(id)).toBe('cancelled');
    expect(box.rows()).toEqual([]);
  });

  it('reads at most five due threads per tick', async () => {
    for (let i = 0; i < 7; i++) create({ sentId: `s${i}`, threadId: `t${i}` });
    const gmail = reader({ ok: true, value: thread() });
    await tick(gmail, outbox().notify);
    expect(gmail.calls).toBe(5);
  });
});

describe('the notice buttons (tap)', () => {
  async function notified(): Promise<{ id: string; nonce: string }> {
    const id = create();
    const box = outbox();
    await tick(reader({ ok: true, value: thread() }), box.notify);
    const parsed = parseButtonId(box.rows()[0]!.buttons[0]!.id)!;
    return { id, nonce: parsed.nonce };
  }

  const issue = (row: { threadId: string }) => {
    const action = pending.create({ tool: 'mail.draft', input: { threadId: row.threadId }, summary: 'draft', tier: 2, principal: ME });
    return { pendingId: action.id, nonce: action.nonce };
  };
  const tap = (id: string, nonce: string, verb: 'draft' | 'no', principal = ME) =>
    store.tap({ principal, id, nonce, verb, issue, supersede: (pid) => pending.supersede(pid, principal) });

  it('draft: the row becomes used and points at a live card', async () => {
    const { id, nonce } = await notified();
    const outcome = tap(id, nonce, 'draft');
    expect(outcome.kind).toBe('card');
    expect(statusOf(id)).toBe('used');
    const card = outcome.kind === 'card' ? outcome.card : null;
    expect(pending.confirm(card!.pendingId, card!.nonce, ME).ok).toBe(true);
  });

  it('a re-tap after a lost reply replaces the card: the old one can no longer run', async () => {
    const { id, nonce } = await notified();
    const first = tap(id, nonce, 'draft');
    const second = tap(id, nonce, 'draft');
    expect(second.kind).toBe('card');
    const old = first.kind === 'card' ? first.card : null;
    const fresh = second.kind === 'card' ? second.card : null;
    expect(pending.confirm(old!.pendingId, old!.nonce, ME)).toEqual({ ok: false, reason: 'not_pending' });
    expect(pending.confirm(fresh!.pendingId, fresh!.nonce, ME).ok).toBe(true);
  });

  it('once the card ran, a re-tap issues nothing', async () => {
    const { id, nonce } = await notified();
    const first = tap(id, nonce, 'draft');
    const card = first.kind === 'card' ? first.card : null;
    pending.confirm(card!.pendingId, card!.nonce, ME);
    expect(tap(id, nonce, 'draft')).toEqual({ kind: 'gone' });
  });

  it('a wrong nonce, another principal, or a 48-hour-old notice is gone', async () => {
    const { id, nonce } = await notified();
    expect(tap(id, 'ab'.repeat(16), 'draft')).toEqual({ kind: 'gone' });
    expect(tap(id, nonce, 'draft', OTHER)).toEqual({ kind: 'gone' });
    now += FOLLOWUP_TAP_MS + 1;
    expect(tap(id, nonce, 'draft')).toEqual({ kind: 'gone' });
    expect(statusOf(id)).toBe('notified');
  });

  it('no: dismissed once; a second no is gone', async () => {
    const { id, nonce } = await notified();
    expect(tap(id, nonce, 'no')).toEqual({ kind: 'dismissed' });
    expect(statusOf(id)).toBe('dismissed');
    expect(tap(id, nonce, 'no')).toEqual({ kind: 'gone' });
  });

  it('an untouched notice is closed by the purge once its buttons expired', async () => {
    const { id } = await notified();
    now += FOLLOWUP_TAP_MS + 1;
    store.purge();
    expect(statusOf(id)).toBe('dismissed');
  });
});

describe('GmailClient.thread', () => {
  it('reads labels, the date and the headers, case-insensitively, and only the From local part', async () => {
    const gmail = new GmailClient({
      async call() {
        return {
          ok: true,
          value: {
            messages: [
              {
                id: 'a',
                labelIds: ['INBOX'],
                internalDate: '1760000000000',
                payload: {
                  headers: [
                    { name: 'FROM', value: 'Mail Delivery <MAILER-DAEMON@example.com>' },
                    { name: 'content-type', value: ' Multipart/Report; report-type=delivery-status ' },
                    { name: 'list-id', value: '<x.example.com>' },
                  ],
                },
              },
              { id: 'b' },
            ],
          },
        };
      },
    });
    const read = await gmail.thread('t');
    expect(read.ok).toBe(true);
    const [first, second] = read.ok ? read.value : [];
    expect(first).toMatchObject({ labelIds: ['INBOX'], internalDate: 1760000000000, fromLocal: 'mailer-daemon', listId: true });
    expect(first!.contentType).toBe('multipart/report; report-type=delivery-status');
    expect(JSON.stringify(first)).not.toContain('example.com>');
    expect(second).toMatchObject({ labelIds: null, internalDate: null });
  });
});

describe('mail.follow_up', () => {
  it('is offered only by "if they don\'t reply" words', () => {
    for (const text of [
      'תזכיר לי אם לא ענו לי על המייל לדני עד יום חמישי ב-9',
      'אם עד מחר אין תשובה על המייל, תזכיר לי',
      'תזכיר לי אם הוא לא יענה על המייל עד ראשון',
      'remind me if nobody replies to my email by Friday',
      "if Dana doesn't answer my email by tomorrow remind me",
    ]) expect(namesFollowUp(text), text).toBe(true);
    for (const text of ['תזכיר לי מחר ב-9 לשלוח מייל לדני', 'מה המיילים האחרונים שלי', 'כשיגיע מייל מדני תזכיר לי']) {
      expect(namesFollowUp(text), text).toBe(false);
    }
  });

  it('keeps the To line single-line and capped, or drops it', () => {
    expect(toLineOf('Dana <d@example.com>')).toBe('Dana <d@example.com>');
    expect(toLineOf('a@b.c\r\nBcc: x@evil.example')).toBe('a@b.c Bcc: x@evil.example');
    expect(toLineOf('x'.repeat(400))).toBeNull();
    expect(toLineOf(null)).toBeNull();
  });

  function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { principal: ME, nowMs: NOW, lang: 'he', channel: 'app', followUps: store, ...overrides } as unknown as ToolContext;
  }
  const slots = { mail: ['דני'], date: { kind: 'relative_days', offset: 1 }, time: { hour: 9, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } };

  it('asks for the hour rather than inventing one, before any Gmail call', async () => {
    let calls = 0;
    const gmail = { search: async () => { calls++; return { ok: true, value: [] }; } };
    const outcome = await mailFollowUp.resolveAsync!({ mail: ['דני'], date: { kind: 'relative_days', offset: 1 } }, ctx({ gmail: gmail as never }));
    expect(outcome.kind).toBe('clarify');
    expect(calls).toBe(0);
  });

  it('searches the sent folder only, with the words code cleaned', async () => {
    const queries: string[] = [];
    const gmail = {
      search: async (query: string) => {
        queries.push(query);
        return { ok: true, value: [{ id: 'm1', threadId: 't1', fromName: 'me', fromAddress: null, subject: 'הצעה', messageId: '<a@b>', toHeader: 'Dani <d@example.com>', at: SENT_AT, snippet: '', unread: false }] };
      },
    };
    const outcome = await mailFollowUp.resolveAsync!({ ...slots, mail: ['דני from:(x) OR'] }, ctx({ gmail: gmail as never }));
    expect(queries[0]).toMatch(/^in:sent newer_than:30d /);
    expect(queries[0]).not.toContain('from:(');
    expect(outcome.kind).toBe('ready');
    expect(outcome.kind === 'ready' ? outcome.input : null).toMatchObject({ threadId: 't1', sentId: 'm1', toHeader: 'Dani <d@example.com>' });
  });

  it('several sent conversations: a choice, never a guess', async () => {
    const mail = (id: string, threadId: string) => ({ id, threadId, fromName: 'me', fromAddress: null, subject: id, messageId: null, toHeader: null, at: SENT_AT, snippet: '', unread: false });
    const gmail = { search: async () => ({ ok: true, value: [mail('a', 't1'), mail('b', 't2')] }) };
    const outcome = await mailFollowUp.resolveAsync!(slots, ctx({ gmail: gmail as never }));
    expect(outcome.kind === 'clarify' ? outcome.clarify.code : null).toBe('ambiguous');
  });

  it('outside the app it does not run', async () => {
    const outcome = await mailFollowUp.resolveAsync!(slots, ctx({ channel: 'whatsapp' }));
    expect(outcome.kind).toBe('clarify');
  });

  it('execute stores it; Undo cancels it', async () => {
    const input = { threadId: 't1', sentId: 'm1', sentMessageId: null, sentAt: SENT_AT, subject: 'הצעה', toHeader: null, dueAt: NOW + 3_600_000 };
    const done = await mailFollowUp.execute(input, ctx());
    expect(store.active(ME)).toHaveLength(1);
    await mailFollowUp.undo!(done.compensating, ctx());
    expect(store.active(ME)).toHaveLength(0);
  });
});

describe('mail.follow_up in the catalog', () => {
  const base = { cards: true, grants: { gmail: true } } as const;

  it('is offered only when the words name it and Gmail is connected; never in the full catalog', () => {
    expect(agentToolNames(base)).not.toContain('mail.follow_up');
    expect(agentToolNames({ ...base, followUp: true })).toContain('mail.follow_up');
    expect(agentToolNames({ cards: true, grants: { gmail: false }, followUp: true })).not.toContain('mail.follow_up');
  });

  it('rides along whatever group the words select', () => {
    const offered = agentToolNames({ ...base, followUp: true });
    expect(selectTools('תזכיר לי אם לא ענו לי על המייל לדני עד יום חמישי ב-9', offered).tools).toContain('mail.follow_up');
    expect(selectTools('remind me if nobody replies to my email by Friday at 10', offered).tools).toContain('mail.follow_up');
  });
});
