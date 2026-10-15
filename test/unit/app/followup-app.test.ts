/**
 * Mail follow-ups through the real Durable Object (block L, L2): the hourly
 * tick with Gmail not connected says so once a day; a notice's draft button
 * issues one live confirmation card for `mail.draft`, and a re-tap replaces
 * it; `/followups` lists and offers cancel buttons.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState } from '../../integration/fake-do-state.js';
import type { FakeDoState } from '../../integration/fake-do-state.js';
import { FakePhone, createFakeGoogle, createServiceAccount, messageId } from '../../integration/fake-phone.js';
import { FollowUpStore } from '../../../src/tools/followup-store.js';
import type { AppEnv } from '../../../src/core/env.js';

const NOW = Date.parse('2026-10-15T09:00:00Z');
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

type Row = { seq: number; text: string; buttons?: Array<{ id: string; title: string }> };
type Answer = { status: string; row?: Row; rows?: Row[] };

describe('mail follow-ups in the app', () => {
  let fake: FakeDoState;
  let assistant: AssistantDO;
  let store: FollowUpStore;

  const send = async (request: Request) => {
    const response = await assistant.fetch(request);
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Answer };
  };
  const pair = async () => {
    const phone = new FakePhone();
    const paired = await send(await phone.pairToDo(BOOTSTRAP));
    phone.deviceId = String((paired.body as unknown as { deviceId: string }).deviceId);
    return phone;
  };
  const say = async (phone: FakePhone, text: string) =>
    (await send(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text }))).body;
  const tap = async (phone: FakePhone, buttonId: string) =>
    (await send(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'button', buttonId }))).body;
  const outboxTexts = async (phone: FakePhone) =>
    ((await send(await phone.toDo('GET', '/app/outbox'))).body as unknown as { rows: Row[] }).rows.map((r) => r.text);
  const tick = () => assistant.fetch(new Request('https://do/do/tick', { method: 'POST' }));
  const principalOf = () => String(fake.driver.exec('SELECT principal FROM inbound_messages LIMIT 1')[0]?.['principal']);
  const livePending = () =>
    fake.driver.exec("SELECT id FROM pending_actions WHERE tool = 'mail.draft' AND status = 'pending' AND expires_at > ?", Date.now()).length;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    const google = createFakeGoogle();
    const env: AppEnv = {
      ENVIRONMENT: 'test',
      WA_APP_SECRET: '',
      WA_VERIFY_TOKEN: '',
      WA_ACCESS_TOKEN: '',
      ALLOWLIST_WA_IDS: SELF,
      GROQ_API_KEY: '',
      GOOGLE_CLIENT_SECRET: 'x',
      TOKEN_ENC_KEY_V1: KEY,
      LOG_HASH_KEY: 'test-key',
      DEVICE_TOKEN_PEPPER: 'test-pepper-not-a-real-secret',
      FCM_SA_KEY: serviceAccount,
      PAIR_BOOTSTRAP_CODE: BOOTSTRAP,
      CHANNEL: 'app',
      WA_PHONE_NUMBER_ID: '',
      GOOGLE_CLIENT_ID: 'x',
      PUBLIC_BASE_URL: 'https://assistant.example.test',
    };
    assistant = new AssistantDO(fake.state as never, env, google.fetchImpl as unknown as typeof fetch);
    await Promise.resolve();
    store = new FollowUpStore(fake.driver, () => Date.now());
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  const due = (principal: string) => {
    const made = store.create({
      principal,
      threadId: 'thread1',
      sentId: 'sent1',
      sentMessageId: '<m1@example.com>',
      sentAt: NOW - 86_400_000,
      subject: 'הצעת מחיר',
      toHeader: 'Dana <dana@example.com>',
      dueAt: NOW - 60_000,
    });
    if (!made.ok) throw new Error(made.reason);
    return made.id;
  };

  it('Gmail not connected: one "could not check" notice a day, and the follow-up waits', async () => {
    const phone = await pair();
    expect((await say(phone, '/followups')).row?.text).toContain('אין מעקבי מייל');
    const id = due(principalOf());
    await tick();
    await tick();
    expect((await outboxTexts(phone)).filter((t) => t.includes('לא הייתה גישה'))).toHaveLength(1);
    expect(store.active(principalOf()).map((f) => f.id)).toEqual([id]);
  });

  it('the draft button issues one live mail.draft card; a re-tap replaces it, never adds one', async () => {
    const phone = await pair();
    await say(phone, '/followups');
    const id = due(principalOf());
    let nonce = '';
    store.settle(id, 'notified', (n) => {
      nonce = n!;
    });

    const first = await tap(phone, `fu:${id}:${nonce}:ok`);
    expect(first.row?.text).toContain('טיוטה');
    expect(livePending()).toBe(1);
    const second = await tap(phone, `fu:${id}:${nonce}:ok`);
    expect(second.row?.text).toContain('טיוטה');
    expect(livePending()).toBe(1);

    const wrong = await tap(phone, `fu:${id}:${'ab'.repeat(16)}:ok`);
    expect(wrong.row?.text).toContain('לא פעיל');
  });

  it('/followups lists what waits, with a cancel button that works once', async () => {
    const phone = await pair();
    await say(phone, '/followups');
    due(principalOf());
    const listed = await say(phone, '/followups');
    expect(listed.row?.text).toContain('הצעת מחיר');
    const cancel = listed.row?.buttons?.[0]?.id;
    expect(cancel).toMatch(/^undo:/);
    expect((await tap(phone, cancel!)).row?.text).toContain('בוטל');
    expect(store.active(principalOf())).toEqual([]);
  });

  it('/suggest: off by default, turned on and off (block L, L3)', async () => {
    const phone = await pair();
    expect((await say(phone, '/suggest')).row?.text).toContain('כבויות');
    expect((await say(phone, '/suggest on')).row?.text).toContain('פעילות');
    expect((await say(phone, '/suggest')).row?.text).toContain('פעילות');
    expect((await say(phone, '/suggest off')).row?.text).toContain('כבויות');
  });
});
