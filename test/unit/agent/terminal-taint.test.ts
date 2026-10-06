/**
 * A read that ends the turn still taints it (2026-10-06, plan review of block
 * E). `mail.bills` and `birthdays.upcoming` answer with code's text and never
 * return to the model, but their words — a mail's subject, a contact's name —
 * stay in the history the model reads next time. That entry must be tainted,
 * so the next turn's writes confirm.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { BirthdayStore } from '../../../src/core/birthdays.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import type { GmailClient } from '../../../src/google/gmail.js';
import type { ContactsClient } from '../../../src/google/contacts.js';
import type { CalendarClient } from '../../../src/google/calendar.js';
import type { GoogleStore } from '../../../src/google/store.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-06T06:00:00Z');
const PRINCIPAL = 'p_taint';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

describe('a terminal read taints the turn it ends', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let history: ConversationHistory;
  let birthdays: BirthdayStore;

  const gmail = {
    search: async () => ({
      ok: true,
      value: [
        { id: 'm1', threadId: 't1', fromName: 'ספק', fromAddress: null, subject: 'חשבונית', messageId: null, at: NOW, snippet: '', unread: true },
      ],
    }),
    body: async () => ({ ok: true, value: 'סה"כ לתשלום ₪100' }),
  } as unknown as GmailClient;

  const deps = (steps: FakeStep[], extra: Partial<Services> = {}): PipelineDeps => {
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      birthdays,
      agent: {
        providers: [createFakeAgent(steps)],
        budget: new TokenBudget(() => NOW),
        history,
        lock: new AgentLock(driver, () => NOW),
      },
      ...extra,
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app', deviceCaps: [] };
  };

  let seq = 0;
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.taint.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    birthdays = new BirthdayStore(driver, () => NOW);
    birthdays.add({ principal: PRINCIPAL, name: 'אמא', day: 7, month: 10 });
  });
  afterEach(() => driver.close());

  it('mail.bills: the answer is code-rendered, and history keeps it tainted', async () => {
    const connected = { isConnected: () => true } as unknown as GoogleStore;
    const out = await handleInbound(
      say('אילו חשבונות יש לי לשלם?'),
      deps([{ tool: 'mail.bills', args: {} }, { text: 'never asked' }], { gmail, grants: { gmail: connected } }),
    );
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.text).toContain('חשבונית');
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it('birthdays.upcoming from the local list alone stays clean', async () => {
    await handleInbound(say('של מי יום הולדת השבוע?'), deps([{ tool: 'birthdays.upcoming', args: { days: 7 } }]));
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: false })]);
  });

  it("a navigation card to an event's location is tainted, and does not run on its own", async () => {
    const calendar = {
      listAllEvents: async () => ({
        ok: true,
        value: [{ id: 'e', title: 'רופא', startUtc: NOW + 3_600_000, endUtc: NOW + 7_200_000, allDay: false, createdByAssistant: false, etag: null, location: 'הרצל 10' }],
      }),
    } as unknown as CalendarClient;
    const base = deps([{ tool: 'nav.go', args: { event: ['רופא'] } }], { calendar });
    const out = await handleInbound(say('תנווט לרופא'), { ...base, deviceCaps: ['cards'] });
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.card).toMatchObject({ type: 'nav', autoRun: false });
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it('birthdays.upcoming with a name from Google Contacts is tainted', async () => {
    const contacts = { birthdays: async () => ({ ok: true, value: [{ name: 'דנה', day: 8, month: 10, year: null }] }) } as unknown as ContactsClient;
    await handleInbound(say('של מי יום הולדת השבוע?'), deps([{ tool: 'birthdays.upcoming', args: { days: 7 } }], { contacts }));
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });
});
