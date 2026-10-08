/**
 * The consent card through the real Durable Object (smart conversations, slice
 * 5): the card is the asking message's answer, a tap's answer is the resumed
 * turn, a retry never runs anything twice, an unanswered card expires as a
 * consent and not as a phone read, the phone's result path cannot take a
 * consent turn, and the object may be evicted between the card and the tap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState } from '../../integration/fake-do-state.js';
import type { FakeDoState } from '../../integration/fake-do-state.js';
import { FakePhone, createFakeGoogle, createServiceAccount, messageId } from '../../integration/fake-phone.js';
import type { FakeGoogle } from '../../integration/fake-phone.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { parseConsentButton } from '../../../src/agent/consents.js';
import { GEMINI_ENDPOINT } from '../../../src/agent/provider.js';
import { consentText } from '../../../src/render/consent.js';
import { he } from '../../../src/render/he.js';
import type { AppEnv } from '../../../src/core/env.js';

const NOW = Date.parse('2026-09-29T09:00:00Z');
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';
const SMART = '66666666-6666-4666-8666-666666666666';
const SECRET = 'לאסוף את החבילה מהדואר';

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

type Row = { seq: number; text: string; inReplyTo: string | null; buttons: { id: string; title: string }[] };
type Answer = { status: string; row?: Row; queryId?: string; query?: unknown };

describe('the consent card in the app', () => {
  let fake: FakeDoState;
  let google: FakeGoogle;
  let env: AppEnv;
  let assistant: AssistantDO;
  let chat: Array<{ tool?: string; text?: string }>;
  let chatUrls: string[];
  let principal: string;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
    chatUrls.push(url);
    const step = chat.shift() ?? { text: 'אין תשובה' };
    const message = step.tool
      ? { content: null, tool_calls: [{ id: `call_${chatUrls.length}`, type: 'function', function: { name: step.tool, arguments: '{}' } }] }
      : { content: step.text };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const build = () => {
    assistant = new AssistantDO(fake.state as never, env, fetchImpl);
  };

  const send = async (request: Request) => {
    const response = await assistant.fetch(request);
    return { status: response.status, body: (await response.json()) as Answer };
  };

  const pair = async () => {
    const phone = new FakePhone();
    const paired = await send(await phone.pairToDo(BOOTSTRAP));
    phone.deviceId = String((paired.body as unknown as { deviceId: string }).deviceId);
    return phone;
  };

  const say = async (phone: FakePhone, text: string, id = messageId()) =>
    (await send(await phone.toDo('POST', '/app/message', { id, kind: 'text', text, conversationId: SMART, mode: 'smart' }))).body;

  const tap = async (phone: FakePhone, buttonId: string, id = messageId()) =>
    (await send(await phone.toDo('POST', '/app/message', { id, kind: 'button', buttonId, conversationId: SMART }))).body;

  const verb = (row: Row, wanted: string) => row.buttons.find((b) => {
    const parsed = parseConsentButton(b.id);
    return parsed?.kind === 'answer' && parsed.verb === wanted;
  })!.id;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    google = createFakeGoogle();
    env = {
      ENVIRONMENT: 'test',
      WA_APP_SECRET: '',
      WA_VERIFY_TOKEN: '',
      WA_ACCESS_TOKEN: '',
      ALLOWLIST_WA_IDS: SELF,
      GROQ_API_KEY: 'test-groq-key',
      GEMINI_API_KEY: 'fake-gemini-key-not-real',
      AGENT: 'on',
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
    chat = [];
    chatUrls = [];
    build();
    await Promise.resolve();
    const { hashPrincipal } = await import('../../../src/security/redact.js');
    principal = await hashPrincipal(SELF, 'test-key');
    new ReminderStore(fake.driver, () => Date.now()).schedule({
      principal,
      text: SECRET,
      dueAtUtc: NOW + 86_400_000,
      localWallTime: '2026-09-30T12:00',
      tz: 'Asia/Jerusalem',
    });
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  /** A smart message whose Gemini turn asks for the reminders: the card. */
  const askCard = async (phone: FakePhone, id = messageId()) => {
    chat = [{ tool: 'reminders__list' }];
    const card = await say(phone, 'מה התזכורות שלי?', id);
    expect(card.status).toBe('reply');
    expect(card.row!.buttons).toHaveLength(3);
    return card.row!;
  };

  it("answers with a card from Gemini's call, and a tap continues the turn once", async () => {
    const phone = await pair();
    const asking = messageId();
    const card = await askCard(phone, asking);
    expect(chatUrls).toEqual([GEMINI_ENDPOINT]);
    expect(card.inReplyTo).toBe(asking);
    expect(card.text).toBe(consentText.card('reminders', 'he'));
    expect(JSON.stringify(card)).not.toContain(SECRET);

    chat = [{ text: 'יש תזכורת אחת' }];
    const tapId = messageId();
    const answered = await tap(phone, verb(card, 'once'), tapId);
    expect(answered.status).toBe('reply');
    expect(answered.row).toMatchObject({ inReplyTo: tapId, text: 'יש תזכורת אחת' });
    expect(chatUrls).toEqual([GEMINI_ENDPOINT, GEMINI_ENDPOINT]);

    // The tap again, and the message again: stored answers, nothing runs.
    expect((await tap(phone, verb(card, 'once'), tapId)).row?.seq).toBe(answered.row!.seq);
    expect((await say(phone, 'מה התזכורות שלי?', asking)).row?.seq).toBe(card.seq);
    expect(chatUrls).toHaveLength(2);
    // A second tap with a new id is a second tap: refused.
    expect((await tap(phone, verb(card, 'once'))).row?.text).toBe(consentText.expired('he'));
    expect(chatUrls).toHaveLength(2);
  });

  it('answers a retry of the asking message with "pending" once its card was acked, never a device query', async () => {
    const phone = await pair();
    const asking = messageId();
    const card = await askCard(phone, asking);
    await send(await phone.toDo('POST', '/app/outbox/ack', { seqs: [card.seq] }));
    expect(await say(phone, 'מה התזכורות שלי?', asking)).toEqual({ status: 'pending' });
    expect(chatUrls).toHaveLength(1);
  });

  it('lets an unanswered card expire as a consent, not as a phone that did not answer', async () => {
    const phone = await pair();
    const asking = messageId();
    const card = await askCard(phone, asking);

    vi.setSystemTime(NOW + 3 * 60_000 + 1_000);
    await assistant.alarm();
    const inbound = fake.driver.exec('SELECT decision, error_code FROM inbound_messages WHERE wamid = ?', `app:in:${asking}`)[0];
    expect(inbound).toEqual({ decision: 'EXPIRED', error_code: 'E_CONSENT_EXPIRED' });
    const rows = (await send(await phone.toDo('GET', '/app/outbox'))).body as unknown as { rows: Row[] };
    expect(rows.rows.map((row) => row.text)).not.toContain(he.phoneReadTimedOut);
    expect(rows.rows.filter((row) => row.inReplyTo === asking)).toHaveLength(1);

    expect((await tap(phone, verb(card, 'conv'))).row?.text).toBe(consentText.expired('he'));
    expect(chatUrls).toHaveLength(1);
    expect(fake.driver.exec('SELECT COUNT(*) AS n FROM conversation_consents')[0]?.['n']).toBe(0);
  });

  it("refuses a consent turn's id on the phone's result path", async () => {
    const phone = await pair();
    const card = await askCard(phone);
    const parsed = parseConsentButton(card.buttons[0]!.id);
    if (parsed?.kind !== 'answer') throw new Error('not a consent card');
    const forged = await send(await phone.toDo('POST', '/app/device-result', { queryId: parsed.queryId, result: { status: 'ok', items: [] } }));
    expect(forged.status).toBe(404);
    expect(chatUrls).toHaveLength(1);

    chat = [{ text: 'יש' }];
    expect((await tap(phone, verb(card, 'once'))).row?.text).toBe('יש');
  });

  it('survives the object being evicted between the card and the tap', async () => {
    const phone = await pair();
    const card = await askCard(phone);
    build();
    await Promise.resolve();

    chat = [{ text: 'יש תזכורת' }];
    const answered = await tap(phone, verb(card, 'conv'));
    expect(answered.row?.text).toBe('יש תזכורת');
    expect(fake.driver.exec('SELECT source, conversation FROM conversation_consents')).toEqual([{ source: 'reminders', conversation: SMART }]);

    // Allowed for the conversation: the next ask reads straight away.
    chat = [{ tool: 'reminders__list' }, { text: 'עדיין' }];
    expect((await say(phone, 'ושוב?')).row?.text).toBe('עדיין');
  });

  it('lists and revokes with /consents', async () => {
    const phone = await pair();
    const card = await askCard(phone);
    chat = [{ text: 'יש' }];
    await tap(phone, verb(card, 'conv'));

    const listed = await say(phone, '/consents');
    expect(listed.row?.text).toBe(consentText.list(['reminders'], 'he'));
    expect(listed.row?.buttons).toHaveLength(1);
    const revoked = await tap(phone, listed.row!.buttons[0]!.id);
    expect(revoked.row?.text).toBe(consentText.revoked('reminders', 'he'));
    expect(fake.driver.exec('SELECT COUNT(*) AS n FROM conversation_consents')[0]?.['n']).toBe(0);
  });
});
