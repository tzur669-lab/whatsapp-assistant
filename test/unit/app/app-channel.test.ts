/**
 * The app channel end to end through the Durable Object (PLAN §6.18).
 *
 * The state transitions the review asked to see pinned: no device → paired →
 * revoked; a message accepted → answered (HTTP and outbox) → acked; a retry of
 * the same message; a turn lost part-way; a reminder pushed, re-pushed, held,
 * expired; `/pair off`; the kill switch; and voice, whose transcript must never
 * be stored.
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState } from '../../integration/fake-do-state.js';
import type { FakeDoState } from '../../integration/fake-do-state.js';
import { FakePhone, createFakeGoogle, createServiceAccount, messageId } from '../../integration/fake-phone.js';
import type { FakeGoogle } from '../../integration/fake-phone.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { DeviceStore } from '../../../src/device/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { he } from '../../../src/render/he.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { REMINDER_ROW_TTL_MS, REPUSH_AFTER_MS } from '../../../src/channels/app/outbox.js';
import { CLOCK_SKEW_MS } from '../../../src/channels/app/verify.js';
import type { AppEnv } from '../../../src/core/env.js';
import { SMART_MODELS } from '../../../src/agent/models.js';

const NOW = Date.parse('2026-09-29T09:00:00Z'); // a Tuesday
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

const baseEnv = (): AppEnv => ({
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
});

type Reply = { status: string; row?: { seq: number; text: string; inReplyTo: string | null; buttons: { id: string }[] } };

describe('the app channel', () => {
  let fake: FakeDoState;
  let google: FakeGoogle;
  let env: AppEnv;
  let assistant: AssistantDO;
  let reminders: ReminderStore;
  let repo: Repository;
  let principal: string;

  const build = (overrides: Partial<AppEnv> = {}) => {
    env = { ...baseEnv(), ...overrides };
    assistant = new AssistantDO(fake.state as never, env, google.fetchImpl);
  };

  const send = async (request: Request) => {
    const response = await assistant.fetch(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const pair = async (code = BOOTSTRAP) => {
    const phone = new FakePhone();
    const paired = await send(await phone.pairToDo(code));
    expect(paired.status).toBe(200);
    phone.deviceId = String(paired.body['deviceId']);
    return phone;
  };

  const say = async (phone: FakePhone, text: string, id = messageId()) =>
    (await send(await phone.toDo('POST', '/app/message', { id, kind: 'text', text }))).body as unknown as Reply;

  const outbox = async (phone: FakePhone) =>
    (await send(await phone.toDo('GET', '/app/outbox'))).body as {
      rows: { seq: number; kind: string; text: string; inReplyTo: string | null }[];
      more: boolean;
    };

  const ack = async (phone: FakePhone, seqs: number[]) =>
    send(await phone.toDo('POST', '/app/outbox/ack', { seqs }));

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    google = createFakeGoogle();
    build();
    await Promise.resolve();

    repo = new Repository(fake.driver);
    reminders = new ReminderStore(fake.driver, () => Date.now());
    const { hashPrincipal } = await import('../../../src/security/redact.js');
    principal = await hashPrincipal(SELF, 'test-key');
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  describe('pairing', () => {
    it('pairs with the bootstrap code, and an old phone stops working when a new one pairs', async () => {
      const first = await pair();
      expect((await outbox(first)).rows).toEqual([]);

      build({ PAIR_BOOTSTRAP_CODE: 'ZYXW-VTSR-QPNM-KJHG-FEDC' });
      const second = await pair('ZYXW-VTSR-QPNM-KJHG-FEDC');

      expect((await send(await first.toDo('GET', '/app/outbox'))).status).toBe(401);
      expect((await send(await second.toDo('GET', '/app/outbox'))).status).toBe(200);
    });

    it('refuses the used bootstrap code to anyone but the phone that used it', async () => {
      const phone = new FakePhone();
      const first = await send(await phone.pairToDo(BOOTSTRAP));
      const retry = await send(await phone.pairToDo(BOOTSTRAP));
      expect(retry.body['deviceId']).toBe(first.body['deviceId']);

      expect((await send(await new FakePhone().pairToDo(BOOTSTRAP))).status).toBe(400);
    });

    it('sends the held reminders once a phone pairs', async () => {
      const held = reminders.schedule({ principal, text: 'לשתות מים', dueAtUtc: NOW - 1_000, localWallTime: '', tz: 'Asia/Jerusalem' });
      await assistant.alarm();
      // Held, not spent: no phone yet, so it was never claimed.
      expect(reminders.byId(held.id)).toMatchObject({ status: 'scheduled', attempts: 0 });

      const phone = await pair();
      await assistant.alarm();
      const rows = (await outbox(phone)).rows;
      expect(rows.map((r) => r.kind)).toEqual(['reminder']);
      expect(stripIsolates(rows[0]!.text)).toContain('לשתות מים');
    });
  });

  describe('signed requests', () => {
    it('refuses a phone clock more than five minutes off, and says why', async () => {
      const phone = await pair();
      const skewed = await send(await phone.toDo('GET', '/app/outbox', undefined, { timestamp: NOW - CLOCK_SKEW_MS - 1 }));
      expect(skewed).toEqual({ status: 401, body: { error: 'clock' } });
    });

    it('refuses a body changed after signing', async () => {
      const phone = await pair();
      const request = await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: '/help' });
      const tampered = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ id: messageId(), kind: 'text', text: '/pair off' }),
      });
      expect((await send(tampered)).status).toBe(401);
    });

    it('refuses a replayed nonce with 409, which the app answers by signing again', async () => {
      const phone = await pair();
      const nonce = 'd'.repeat(32);
      await send(await phone.toDo('GET', '/app/outbox', undefined, { nonce }));
      expect((await send(await phone.toDo('GET', '/app/outbox', undefined, { nonce }))).status).toBe(409);
    });
  });

  describe('a message and its answer', () => {
    it('answers in the HTTP response and keeps the same answer in the outbox until acked', async () => {
      const phone = await pair();
      const id = messageId();
      const reply = await say(phone, '/help', id);

      expect(reply.status).toBe('reply');
      expect(reply.row?.inReplyTo).toBe(id);
      expect(reply.row?.text).toBe(he.helpApp);

      const rows = (await outbox(phone)).rows;
      expect(rows.map((r) => r.seq)).toEqual([reply.row!.seq]);

      expect((await ack(phone, [reply.row!.seq])).status).toBe(200);
      expect((await outbox(phone)).rows).toEqual([]);
      expect(repo.getOutbound(`app:${reply.row!.seq}`)?.['delivery_status']).toBe('delivered');
    });

    it('keeps the one-time connect link a link, though every other link is defanged (PLAN §6.19)', async () => {
      const phone = await pair();
      const reply = await say(phone, '/connect google');
      expect(reply.row?.text).toContain('https://assistant.example.test/oauth/google/start?id=');
    });

    it('runs a retried message once, and gives the retry the same answer', async () => {
      const phone = await pair();
      const id = messageId();
      const first = await say(phone, '/pause', id);
      const retry = await say(phone, '/pause', id);

      expect(retry).toEqual(first);
      expect(repo.isPaused()).toBe(true);
      expect((await outbox(phone)).rows).toHaveLength(1);
    });

    it('says "done" for a retry after the answer was acked', async () => {
      const phone = await pair();
      const id = messageId();
      const first = await say(phone, '/help', id);
      await ack(phone, [first.row!.seq]);
      expect(await say(phone, '/help', id)).toEqual({ status: 'done' });
    });

    it('says "unknown" for a message recorded long ago that never finished, and does not run it', async () => {
      const phone = await pair();
      const id = messageId();
      repo.recordInbound({ wamid: `app:in:${id}`, principal, receivedAt: NOW - 3 * 60_000, sentAt: NOW, kind: 'text' });
      expect(await say(phone, '/pause', id)).toEqual({ status: 'unknown' });
      expect(repo.isPaused()).toBe(false);
    });

    it('does not spend a message id on a malformed body', async () => {
      const phone = await pair();
      const id = messageId();
      const bad = await send(await phone.toDo('POST', '/app/message', { id, kind: 'text', text: '' }));
      expect(bad.status).toBe(400);
      expect((await say(phone, '/help', id)).status).toBe('reply');
    });

    it('only acks the rows named, never "everything up to"', async () => {
      const phone = await pair();
      const a = await say(phone, '/help');
      const b = await say(phone, '/status');
      await ack(phone, [b.row!.seq]);
      expect((await outbox(phone)).rows.map((r) => r.seq)).toEqual([a.row!.seq]);
    });

    it('has no message budget in the app', async () => {
      const phone = await pair();
      expect((await say(phone, '/budget')).row?.text).toBe('באפליקציה אין מגבלת הודעות חודשית.');
      expect(stripIsolates((await say(phone, '/status')).row!.text)).not.toContain('הודעות החודש');
    });

    it('does not hand out a pairing code in a reply', async () => {
      const phone = await pair();
      const text = (await say(phone, '/pair')).row!.text;
      expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    });
  });

  describe('reminders', () => {
    const due = (text: string, at = NOW - 1_000) =>
      reminders.schedule({ principal, text, dueAtUtc: at, localWallTime: '', tz: 'Asia/Jerusalem' });

    it('are accepted into the outbox, pushed with nothing but "there is something", and delivered on ack', async () => {
      const phone = await pair();
      const reminder = due('להתקשר לאבא');
      await assistant.alarm();

      expect(reminders.byId(reminder.id)?.status).toBe('sent');
      expect(google.pushes).toEqual([{ kind: 'outbox' }]);

      const [row] = (await outbox(phone)).rows;
      expect(row?.kind).toBe('reminder');
      expect(repo.getOutbound(`app:${row!.seq}`)?.['delivery_status']).toBe('accepted');

      await ack(phone, [row!.seq]);
      expect(repo.getOutbound(`app:${row!.seq}`)?.['delivery_status']).toBe('delivered');
    });

    it('carry a Waze card to the place of a "time to leave" reminder, off the lock screen (ROADMAP #5)', async () => {
      const phone = await pair();
      reminders.schedule({
        principal,
        text: 'לצאת ל־רופא שיניים',
        dueAtUtc: NOW - 1_000,
        localWallTime: '',
        tz: 'Asia/Jerusalem',
        place: 'הרצל 10, רחובות',
      });
      await assistant.alarm();
      const [row] = (await outbox(phone)).rows as unknown as {
        card?: { actionId: string; type: string; autoRun: boolean; preview: string };
        private?: boolean;
      }[];
      expect(row?.card).toMatchObject({ type: 'nav', autoRun: false });
      expect(stripIsolates(row!.card!.preview)).toContain('הרצל 10, רחובות');
      expect(row?.private).toBe(true);
      // The card outlives the five minutes a confirmation gets.
      const stored = fake.driver.exec('SELECT expires_at, channel FROM pending_actions WHERE id = ?', row!.card!.actionId)[0]!;
      expect(stored['channel']).toBe('card');
      expect(Number(stored['expires_at'])).toBe(NOW + 2 * 60 * 60 * 1000);
    });

    it('carry no card for an ordinary reminder', async () => {
      const phone = await pair();
      due('להתקשר לאבא');
      await assistant.alarm();
      const [row] = (await outbox(phone)).rows as unknown as { card?: unknown; private?: boolean }[];
      expect(row?.card).toBeUndefined();
      expect(row?.private).toBeUndefined();
    });

    it('leave with any link in them defanged (PLAN §6.19)', async () => {
      const phone = await pair();
      due('להיכנס ל-https://evil.example/x ולשלם');
      await assistant.alarm();
      const [row] = (await outbox(phone)).rows;
      expect(row?.text).toContain('evil[.]example/x');
      expect(row?.text).not.toContain('https://');
    });

    it('are pushed again after 15 minutes, an hour and four hours — and then left waiting', async () => {
      await pair();
      due('לקחת תרופה');
      await assistant.alarm();
      expect(google.pushes).toHaveLength(1);

      let at = NOW;
      for (const delay of REPUSH_AFTER_MS) {
        at += delay;
        vi.setSystemTime(at);
        await assistant.alarm();
      }
      expect(google.pushes).toHaveLength(1 + REPUSH_AFTER_MS.length);

      vi.setSystemTime(at + 24 * 60 * 60 * 1000);
      await assistant.alarm();
      expect(google.pushes).toHaveLength(1 + REPUSH_AFTER_MS.length);
    });

    it('are retired, not silently dropped, after seven days unfetched', async () => {
      await pair();
      const reminder = due('משהו');
      await assistant.alarm();
      const seq = Number(fake.driver.exec('SELECT seq FROM app_outbox')[0]!['seq']);

      vi.setSystemTime(NOW + REMINDER_ROW_TTL_MS);
      await assistant.alarm();

      expect(fake.driver.exec('SELECT * FROM app_outbox WHERE seq = ?', seq)).toEqual([]);
      expect(repo.getOutbound(`app:${seq}`)?.['delivery_status']).toBe('failed');
      expect(['failed', 'done']).toContain(reminders.byId(reminder.id)?.status);
    });

    it('keep their schedule when a push fails, and forget an address FCM calls gone', async () => {
      const phone = await pair();
      google.failPushes(404);
      due('משהו');
      await assistant.alarm();
      expect(google.pushes).toHaveLength(1);
      expect((await outbox(phone)).rows).toHaveLength(1);
      expect(fake.driver.exec('SELECT push_token_enc FROM devices WHERE id = ?', phone.deviceId)[0]!['push_token_enc']).toBeNull();
    });

    it('are not held by the 24-hour window, which the app does not have', async () => {
      await pair();
      vi.setSystemTime(NOW + 3 * 24 * 60 * 60 * 1000);
      due('אחרי שלושה ימים של שקט', Date.now() - 1_000);
      await assistant.alarm();
      expect(fake.driver.exec('SELECT kind FROM app_outbox')).toEqual([{ kind: 'reminder' }]);
    });

    it('go back in the queue on /pair off, and wait for the next phone', async () => {
      const phone = await pair();
      const reminder = due('משהו');
      await assistant.alarm();

      const reply = await say(phone, '/pair off');
      expect(stripIsolates(reply.row!.text)).toContain('הטלפון נותק');
      expect(reply.row!.seq).toBe(0); // in the response only: nothing waits for a phone that is gone
      expect(reminders.byId(reminder.id)?.status).toBe('scheduled');
      expect(fake.driver.exec('SELECT * FROM app_outbox')).toEqual([]);
      expect((await send(await phone.toDo('GET', '/app/outbox'))).status).toBe(401);

      await assistant.alarm();
      expect(reminders.byId(reminder.id)?.status).toBe('scheduled');

      build({ PAIR_BOOTSTRAP_CODE: 'ZYXW-VTSR-QPNM-KJHG-FEDC' });
      const next = await pair('ZYXW-VTSR-QPNM-KJHG-FEDC');
      await assistant.alarm();
      expect((await outbox(next)).rows.map((r) => r.kind)).toEqual(['reminder']);
    });

    it('are held, not sent and not spent, with the kill switch on', async () => {
      await pair();
      build({ CHANNEL: 'off' });
      const reminder = due('משהו');
      await assistant.alarm();
      expect(reminders.byId(reminder.id)?.status).toBe('scheduled');
      expect(reminders.byId(reminder.id)?.attempts).toBe(0);
      expect(google.pushes).toEqual([]);
    });
  });

  describe('voice', () => {
    const record = async (phone: FakePhone, id = messageId(), contentType = 'audio/mp4') =>
      send(await phone.toDo('POST', `/app/voice/${id}`, new Uint8Array([1, 2, 3, 4]), { contentType }));

    it('echoes what was heard in the response, and stores the answer without it', async () => {
      build({ GROQ_API_KEY: 'test-key-not-real' });
      google.transcript = 'עזרה';
      const phone = await pair();

      const reply = (await record(phone)).body as unknown as Reply;
      expect(stripIsolates(reply.row!.text).startsWith('שמעתי: עזרה')).toBe(true);

      const stored = String(fake.driver.exec('SELECT text FROM app_outbox')[0]!['text']);
      expect(stored).not.toContain('שמעתי');
      expect(stored).toContain(he.heardNotKept);
    });

    it('refuses a type it cannot transcribe', async () => {
      const phone = await pair();
      expect((await record(phone, messageId(), 'image/png')).status).toBe(415);
    });

    it('stops paying for Whisper after an hour’s worth of recordings', async () => {
      build({ GROQ_API_KEY: 'test-key-not-real' });
      google.transcript = 'עזרה';
      const phone = await pair();
      for (let i = 0; i < 60; i++) {
        repo.recordInbound({ wamid: `app:in:${messageId()}`, principal, receivedAt: NOW - 1_000, sentAt: NOW, kind: 'audio' });
      }
      const reply = (await record(phone)).body as unknown as Reply;
      expect(reply.row?.text).toBe(he.voiceTooMany);
      expect(google.requests.some((url) => url.includes('/audio/transcriptions'))).toBe(false);
    });
  });

  describe('conversations (2026-10-01)', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    /** What the model was sent on each call: the user messages only. */
    let seen: string[][];

    const buildWithAgent = () => {
      env = { ...baseEnv(), GROQ_API_KEY: 'test-groq-key', AGENT: 'on' };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string | null }[] };
        seen.push(body.messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: `תשובה ${seen.length}` } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
    };

    const sayIn = async (phone: FakePhone, conversationId: string, text: string) =>
      (await send(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text, conversationId })))
        .body as unknown as Reply;

    beforeEach(() => {
      seen = [];
    });

    it('remembers each conversation on its own', async () => {
      buildWithAgent();
      const phone = await pair();

      // A minute apart: three full-catalog turns in one minute would overflow
      // a model's 8K bucket, and this test is about memory, not rate.
      await sayIn(phone, A, 'אני בשיחה א');
      vi.advanceTimersByTime(61_000);
      await sayIn(phone, B, 'אני בשיחה ב');
      vi.advanceTimersByTime(61_000);
      await sayIn(phone, A, 'ומה אמרתי?');

      // The third call, in A, sees A's earlier words and not B's.
      const third = seen[2]!.join('\n');
      expect(third).toContain('אני בשיחה א');
      expect(third).not.toContain('אני בשיחה ב');
      // The second, in B, saw nothing of A.
      expect(seen[1]!.join('\n')).not.toContain('אני בשיחה א');
    });

    it('refuses a conversation id that is not a uuid', async () => {
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: 'x', conversationId: 'not-a-uuid' }),
      );
      expect(response.status).toBe(400);
    });

    it('takes a voice note with its conversation in the path', async () => {
      build({ GROQ_API_KEY: 'test-key-not-real' });
      google.transcript = 'עזרה';
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', `/app/voice/${messageId()}/${A}`, new Uint8Array([1, 2, 3, 4]), { contentType: 'audio/mp4' }),
      );
      expect(response.status).toBe(200);
      expect(stripIsolates((response.body as unknown as Reply).row!.text).startsWith('שמעתי: עזרה')).toBe(true);
    });
  });

  describe('text shared from another app (block F, 2026-10-06)', () => {
    it('reaches the model under a header, taints the turn and keeps the answer off the lock screen', async () => {
      env = { ...baseEnv(), GROQ_API_KEY: 'test-groq-key', AGENT: 'on' };
      const seen: string[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string | null }[] };
        seen.push(...body.messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'בסדר' } }], usage: { prompt_tokens: 900, completion_tokens: 10 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
      const phone = await pair();

      const response = await send(
        await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: 'מה זה?', shared: 'פגישה מחר ב-14:00' }),
      );
      expect(response.status).toBe(200);
      const user = seen.join(' ');
      expect(user).toContain('מה זה?');
      expect(user).toContain('הטקסט ששותף');
      expect(user).toContain('פגישה מחר ב-14:00');
      expect((response.body as unknown as { row: { private?: boolean } }).row.private).toBe(true);
    });

    it('refuses shared text under a command', async () => {
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: '/pause', shared: 'x' }),
      );
      expect(response.status).toBe(400);
      expect(repo.isPaused()).toBe(false);
    });

    it('takes the longest message and shared text, three bytes a character, under the size cap', async () => {
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', '/app/message', {
          id: messageId(),
          kind: 'text',
          text: '₪'.repeat(2_000),
          shared: '₪'.repeat(1_200),
        }),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("the phone's location (2026-10-01)", () => {
    const HERE = { latitude: 32.0853, longitude: 34.7818 };
    let bodies: string[];
    let forecasts: URL[];

    /** An agent that reads the weather once, then answers; and a forecast service. */
    const buildWithWeather = () => {
      env = { ...baseEnv(), GROQ_API_KEY: 'test-groq-key', AGENT: 'on' };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('https://api.open-meteo.com/')) {
          forecasts.push(new URL(url));
          return new Response(
            JSON.stringify({
              daily: { time: ['2026-09-29'], weather_code: [0], temperature_2m_max: [30], temperature_2m_min: [20], precipitation_probability_max: [0] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
        bodies.push(String(init?.body));
        const message =
          bodies.length === 1
            ? { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'info__lookup', arguments: '{"topic":"weather"}' } }] }
            : { content: 'חם היום.' };
        return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
    };

    beforeEach(() => {
      bodies = [];
      forecasts = [];
    });

    it('reads the weather where the phone is, and keeps the coordinates from the model and from storage', async () => {
      buildWithWeather();
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: 'מה מזג האוויר?', location: HERE }),
      );
      expect(response.status).toBe(200);

      expect(forecasts).toHaveLength(1);
      expect(forecasts[0]!.searchParams.get('latitude')).toBe('32.09');
      expect(forecasts[0]!.searchParams.get('longitude')).toBe('34.78');
      // The model read "your current location", never a number for it.
      expect(stripIsolates(bodies[1]!)).toContain('מזג האוויר במיקום הנוכחי שלך');
      for (const body of bodies) expect(body).not.toMatch(/32\.0|34\.7/);

      const tables = fake.driver
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row['name']));
      const dump = tables.map((table) => JSON.stringify(fake.driver.exec(`SELECT * FROM ${table}`))).join('\n');
      expect(dump).not.toMatch(/32\.0|34\.7/);
    });

    it('names the town the phone found for its location', async () => {
      buildWithWeather();
      const phone = await pair();
      const response = await send(
        await phone.toDo('POST', '/app/message', {
          id: messageId(),
          kind: 'text',
          text: 'מה מזג האוויר?',
          location: { ...HERE, name: 'תל אביב-יפו' },
        }),
      );
      expect(response.status).toBe(200);
      expect(stripIsolates(bodies[1]!)).toContain('מזג האוויר בתל אביב-יפו, לפי המיקום הנוכחי שלך');
      for (const body of bodies) expect(body).not.toMatch(/32\.0|34\.7/);
    });

    it('refuses a location off-shape', async () => {
      const phone = await pair();
      for (const location of [
        { latitude: 91, longitude: 0 },
        { latitude: 1, longitude: 2, accuracy: 3 },
        { lat: 1, lon: 2 },
        { latitude: 1, longitude: 2, name: 'הרצל 12' },
        { latitude: 1, longitude: 2, name: 'example.com/x' },
        { latitude: 1, longitude: 2, name: '' },
        { latitude: 1, longitude: 2, name: 'א'.repeat(41) },
      ]) {
        const response = await send(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: 'x', location }));
        expect(response.status).toBe(400);
      }
    });

    it("takes a voice note's location in its path, after the conversation or without one", async () => {
      build({ GROQ_API_KEY: 'test-key-not-real' });
      google.transcript = 'עזרה';
      const phone = await pair();
      const A = '11111111-1111-4111-8111-111111111111';
      const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
      for (const path of [
        `/app/voice/${messageId()}/@32.09,34.78`,
        `/app/voice/${messageId()}/${A}/@-33.87,151.21`,
        `/app/voice/${messageId()}/@32.79,34.99,${hex('חיפה')}`,
      ]) {
        const response = await send(await phone.toDo('POST', path, new Uint8Array([1, 2, 3, 4]), { contentType: 'audio/mp4' }));
        expect(response.status).toBe(200);
      }
      const bad = await send(
        await phone.toDo('POST', `/app/voice/${messageId()}/@99.99,34.78`, new Uint8Array([1, 2, 3, 4]), { contentType: 'audio/mp4' }),
      );
      expect(bad.status).toBe(400);
      // A name with digits, or bytes that are not UTF-8, is refused like a bad location.
      for (const name of [hex('הרצל 12'), 'ff']) {
        const refused = await send(
          await phone.toDo('POST', `/app/voice/${messageId()}/@32.79,34.99,${name}`, new Uint8Array([1, 2, 3, 4]), {
            contentType: 'audio/mp4',
          }),
        );
        expect(refused.status).toBe(400);
      }
    });
  });

  describe('quotas (2026-10-01)', () => {
    type Quota = {
      at: number;
      models: Array<{
        model: string;
        role: string;
        requests: { limit: number; remaining: number } | null;
        minuteTokens: { limit: number; remaining: number } | null;
        dayTokens: { limit: number; used: number } | null;
      }>;
      voice: { used: number; limit: number };
      workerRequests: { limit: number; used: number };
      server: {
        minute: Array<{ model: string; used: number; limit: number; freesAt: number | null; blockedUntil: number | null }>;
        turnTokenCap: number;
        lastFailure: { code: string; at: number | null } | null;
        fallbacksToday: number;
      };
    };

    let modelUrls: string[] = [];
    const buildWithGroq = (overrides: Partial<AppEnv> = {}) => {
      env = { ...baseEnv(), GROQ_API_KEY: 'test-groq-key', AGENT: 'on', ...overrides };
      modelUrls = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
        modelUrls.push(url);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'שלום' } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-limit-requests': '1000',
              'x-ratelimit-remaining-requests': '812',
              'x-ratelimit-reset-requests': '4m10s',
              'x-ratelimit-limit-tokens': '8000',
              'x-ratelimit-remaining-tokens': '7060',
              'x-ratelimit-reset-tokens': '7.5s',
            },
          },
        );
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
    };

    const quota = async (phone: FakePhone) => (await send(await phone.toDo('GET', '/app/quota'))).body as unknown as Quota;

    it('shows what Groq reported, the tokens counted here, and the requests of the day', async () => {
      buildWithGroq();
      const phone = await pair();
      await say(phone, 'מה נשמע?');

      const report = await quota(phone);
      const primary = report.models.find((m) => m.role === 'primary')!;
      expect(primary.requests).toMatchObject({ limit: 1000, remaining: 812 });
      expect(primary.minuteTokens).toMatchObject({ limit: 8000, remaining: 7060 });
      expect(primary.dayTokens).toEqual({ limit: 200_000, used: 940 });

      // Heard nothing yet about the fallback or Whisper: unknown, not full.
      expect(report.models.find((m) => m.role === 'fallback')!.requests).toBeNull();
      expect(report.models.find((m) => m.role === 'voice')!.dayTokens).toBeNull();

      expect(report.voice).toEqual({ used: 0, limit: 60 });
      // Pairing, the message and this request itself.
      expect(report.workerRequests.used).toBeGreaterThanOrEqual(3);
      expect(report.workerRequests.limit).toBe(100_000);

      // This server's own limits, which no Groq header shows; the minute is
      // Groq's own reading while fresh (2026-10-05): 8,000 - 7,060.
      expect(report.server.turnTokenCap).toBe(7_000);
      expect(report.server.minute[0]).toMatchObject({ used: 940, limit: 8_000, blockedUntil: null });
      expect(report.server.lastFailure).toBeNull();
      expect(report.server.fallbacksToday).toBe(0);
    });

    it("learns a model's minute limit from Groq, and shows the last failure", async () => {
      buildWithGroq();
      const phone = await pair();
      await say(phone, 'מה נשמע?');
      fake.driver.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_error_code', 'E_AGENT_BUDGET_EXHAUSTED')");
      const report = await quota(phone);
      // Groq said 8,000, and its own reading is what the minute shows while
      // fresh (2026-10-05); the 500 margin is kept inside fits(), not shown.
      expect(report.server.minute[0]!.limit).toBe(8_000);
      expect(report.server.lastFailure).toEqual({ code: 'E_AGENT_BUDGET_EXHAUSTED', at: null });
    });

    it('shows Gemini on its own line when its key is set, and no turn calls it yet', async () => {
      buildWithGroq({ GEMINI_API_KEY: 'fake-gemini-key-not-real' });
      const phone = await pair();
      await say(phone, 'מה נשמע?');
      expect(modelUrls.length).toBeGreaterThan(0);
      expect(modelUrls.every((url) => url.startsWith('https://api.groq.com/'))).toBe(true);

      const report = await quota(phone);
      const gemini = SMART_MODELS[0]!.id;
      expect(report.models.find((m) => m.model === gemini)).toMatchObject({ role: 'fallback', dayTokens: null });
      expect(report.server.minute.map((m) => m.model)).toContain(gemini);
    });

    it('shows no Gemini line without its key', async () => {
      buildWithGroq();
      const phone = await pair();
      const report = await quota(phone);
      const gemini = SMART_MODELS[0]!.id;
      expect(report.models.map((m) => m.model)).not.toContain(gemini);
      expect(report.server.minute.map((m) => m.model)).not.toContain(gemini);
    });

    it('is only for a paired phone', async () => {
      await pair();
      const response = await send(await new FakePhone().toDo('GET', '/app/quota', undefined, { unsigned: true }));
      expect(response.status).toBe(401);
    });
  });

  describe('separate Google grants (2026-10-01)', () => {
    const buildWithTokens = () => {
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === 'https://oauth2.googleapis.com/token' && String(init?.body).includes('grant_type=authorization_code')) {
          return new Response(
            JSON.stringify({
              access_token: 'at',
              expires_in: 3600,
              refresh_token: 'rt-gmail-not-real',
              scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return google.fetchImpl(input as never, init);
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
    };

    const post = async (path: string, body: unknown) =>
      (await assistant.fetch(new Request(`https://do${path}`, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<
        Record<string, string>
      >;

    it('connects Gmail under its own grant and scopes, and leaves the calendar alone', async () => {
      buildWithTokens();
      const phone = await pair();

      const reply = await say(phone, '/connect gmail');
      expect(stripIsolates(reply.row!.text)).toContain('לחיבור Gmail:');
      const linkId = /id=([0-9a-f]{64})/.exec(stripIsolates(reply.row!.text))![1]!;

      const started = await post('/do/oauth/start', { linkId });
      const redirect = new URL(started['redirectUrl']!);
      expect(redirect.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
      );

      const finished = await post('/do/oauth/callback', { code: 'fake-code', state: redirect.searchParams.get('state') });
      expect(finished).toEqual({ ok: true });

      const rows = fake.driver.exec('SELECT account, status, scopes FROM integrations ORDER BY account');
      expect(rows).toEqual([
        { account: 'gmail', status: 'connected', scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' },
      ]);
      expect(stripIsolates((await say(phone, '/status')).row!.text)).toContain('• Gmail: מחובר');
    });

    it('still connects the calendar with /connect google, now able to read every calendar', async () => {
      const phone = await pair();
      const reply = await say(phone, '/connect google');
      const linkId = /id=([0-9a-f]{64})/.exec(stripIsolates(reply.row!.text))![1]!;
      const started = await post('/do/oauth/start', { linkId });
      expect(new URL(started['redirectUrl']!).searchParams.get('scope')).toContain('calendar.readonly');
    });
  });

  describe('action cards (PLAN §6.20)', () => {
    const card = (tier = 1, channel: 'card' | 'chat' = 'card') =>
      new PendingActions(fake.driver, () => Date.now()).create({
        tool: 'alarm.set',
        input: { type: 'alarm', hour: 6, minute: 30 },
        summary: 'alarm',
        tier,
        principal,
        channel,
      });
    const claim = async (phone: FakePhone, body: Record<string, unknown>) =>
      send(await phone.toDo('POST', '/app/action/claim', body));

    it('records what the app says it can do, and forgets it when an older build says nothing', async () => {
      const phone = await pair();
      const devices = new DeviceStore(fake.driver, () => Date.now(), () => 'x', () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
      expect((await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['cards'] }))).status).toBe(200);
      expect(devices.capsOf(phone.deviceId!)).toEqual(['cards']);
      await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok' }));
      expect(devices.capsOf(phone.deviceId!)).toEqual([]);
    });

    it('drops a capability it does not know, and keeps the push address (2026-10-06)', async () => {
      // A newer app on an older server must still get its pushes; only known caps are stored.
      const phone = await pair();
      const devices = new DeviceStore(fake.driver, () => Date.now(), () => 'x', () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
      expect((await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['root', 'cards', 'a,b'] }))).status).toBe(200);
      expect(devices.capsOf(phone.deviceId!)).toEqual(['cards']);
      expect((await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['x'.repeat(33)] }))).status).toBe(400);
    });

    it('hands the parameters over once, to a signed claim with the nonce', async () => {
      const phone = await pair();
      const action = card();
      const first = await claim(phone, { actionId: action.id, nonce: action.nonce, verb: 'ok' });
      expect(first.body).toEqual({ status: 'ok', action: { type: 'alarm', hour: 6, minute: 30 } });
      const again = await claim(phone, { actionId: action.id, nonce: action.nonce, verb: 'ok' });
      expect(again.body).toEqual({ status: 'refused', reason: 'used' });
    });

    it('refuses a wrong nonce without saying how close it came', async () => {
      const phone = await pair();
      const action = card();
      const forged = await claim(phone, { actionId: action.id, nonce: 'f'.repeat(32), verb: 'ok' });
      expect(forged.body).toEqual({ status: 'refused', reason: 'not_found' });
    });

    it('never claims a chat confirmation as a card', async () => {
      const phone = await pair();
      const chat = card(2, 'chat');
      expect((await claim(phone, { actionId: chat.id, nonce: chat.nonce, verb: 'ok' })).body).toEqual({ status: 'refused', reason: 'not_found' });
    });

    it('refuses an expired card', async () => {
      const phone = await pair();
      const action = card();
      vi.setSystemTime(NOW + 6 * 60_000);
      expect((await claim(phone, { actionId: action.id, nonce: action.nonce, verb: 'ok' })).body).toEqual({ status: 'refused', reason: 'expired' });
    });

    it('lets the user refuse a card, which then cannot run', async () => {
      const phone = await pair();
      const action = card();
      expect((await claim(phone, { actionId: action.id, nonce: action.nonce, verb: 'no' })).body).toEqual({ status: 'cancelled' });
      expect((await claim(phone, { actionId: action.id, nonce: action.nonce, verb: 'ok' })).body).toEqual({ status: 'refused', reason: 'used' });
    });

    it('records what happened on the phone, and sends nothing back', async () => {
      const phone = await pair();
      const action = card();
      const reported = await send(await phone.toDo('POST', '/app/action/report', { actionId: action.id, outcome: 'done' }));
      expect(reported.body).toEqual({ ok: true });
      expect((await outbox(phone)).rows).toEqual([]);
    });
  });
  describe('phone reads (PLAN §6.21)', () => {
    /** Scripted Groq chat completions, in front of the fake Google. */
    let chat: Array<{ tool?: string; args?: Record<string, unknown>; text?: string }>;
    let chatCalls: number;

    const buildWithAgent = () => {
      env = { ...baseEnv(), GROQ_API_KEY: 'test-groq-key', AGENT: 'on' };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('/chat/completions')) return google.fetchImpl(input as never, init);
        const step = chat[chatCalls++] ?? { text: 'אין תשובה' };
        const message = step.tool
          ? {
              content: null,
              tool_calls: [{ id: `call_${chatCalls}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }],
            }
          : { content: step.text };
        return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      assistant = new AssistantDO(fake.state as never, env, fetchImpl);
    };

    const pairReader = async () => {
      buildWithAgent();
      const phone = await pair();
      await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['cards', 'device_query'] }));
      return phone;
    };

    const result = async (phone: FakePhone, queryId: string, items: Record<string, unknown>[] = []) =>
      (await send(await phone.toDo('POST', '/app/device-result', { queryId, result: { status: 'ok', items } }))).body as unknown as Reply & {
        row?: { private?: boolean };
      };

    const ITEMS = [{ sender: 'אמא', text: 'תתקשר כשאתה מתפנה', at: NOW - 60_000 }];

    beforeEach(() => {
      chat = [];
      chatCalls = 0;
    });

    it('answers a read with a query, gives a retry the same one, and continues once on the result', async () => {
      const phone = await pairReader();
      chat = [{ tool: 'phone__sms', args: {} }, { text: 'אמא ביקשה שתתקשר.' }];
      const id = messageId();

      const asked = (await say(phone, 'מה כתבו לי ב-SMS?', id)) as unknown as { status: string; queryId: string; query: unknown };
      expect(asked).toEqual({ status: 'device_query', queryId: expect.stringMatching(/^[0-9a-f]{32}$/), query: { kind: 'sms', hours: 24 } });
      expect((await outbox(phone)).rows).toEqual([]);

      const retried = (await say(phone, 'מה כתבו לי ב-SMS?', id)) as unknown as { status: string; queryId: string };
      expect(retried).toMatchObject({ status: 'device_query', queryId: asked.queryId });

      const answered = await result(phone, asked.queryId, ITEMS);
      expect(answered.status).toBe('reply');
      expect(answered.row).toMatchObject({ inReplyTo: id, text: 'אמא ביקשה שתתקשר.', private: true });
      expect(chatCalls).toBe(2);

      // The same result again, and the message again: the stored answer, never a second run.
      expect((await result(phone, asked.queryId, ITEMS)).row?.seq).toBe(answered.row!.seq);
      expect((await say(phone, 'מה כתבו לי ב-SMS?', id)).row?.seq).toBe(answered.row!.seq);
      expect(chatCalls).toBe(2);

      const rows = (await outbox(phone)).rows as Array<{ inReplyTo: string | null; private?: boolean }>;
      expect(rows).toEqual([expect.objectContaining({ inReplyTo: id, private: true })]);
    });

    it('never offers a phone read to a build that did not say it answers them', async () => {
      buildWithAgent();
      const phone = await pair();
      await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['cards'] }));
      chat = [{ tool: 'phone__sms', args: {} }, { text: 'אין לי גישה ל-SMS.' }];
      const reply = await say(phone, 'מה כתבו לי ב-SMS?');
      expect(reply.status).toBe('reply');
      expect(reply.row?.text).toBe('אין לי גישה ל-SMS.');
    });

    it('answers "no answer in time" under the message when the phone never sends one', async () => {
      const phone = await pairReader();
      chat = [{ tool: 'phone__notifications', args: {} }];
      const id = messageId();
      const asked = (await say(phone, 'מה ההתראות שלי?', id)) as unknown as { queryId: string };

      vi.setSystemTime(NOW + 3 * 60_000 + 1_000);
      await assistant.alarm();
      const rows = (await outbox(phone)).rows;
      expect(rows).toEqual([expect.objectContaining({ inReplyTo: id, text: he.phoneReadTimedOut })]);

      // A result that arrives after that gets the same answer, and nothing runs.
      expect((await result(phone, asked.queryId, ITEMS)).row?.text).toBe(he.phoneReadTimedOut);
      expect(chatCalls).toBe(1);
    });

    it('refuses a result for a query it never asked, and a malformed one', async () => {
      const phone = await pairReader();
      expect((await send(await phone.toDo('POST', '/app/device-result', { queryId: 'a'.repeat(32), result: { status: 'ok', items: [] } }))).status).toBe(404);
      expect(
        (await send(await phone.toDo('POST', '/app/device-result', { queryId: 'a'.repeat(32), result: { status: 'ok', items: [{ number: '0501234567' }] } }))).status,
      ).toBe(400);
    });

    it('forgets a waiting turn when the phone is unpaired', async () => {
      const phone = await pairReader();
      chat = [{ tool: 'phone__sms', args: {} }];
      await say(phone, 'מה כתבו לי ב-SMS?');
      expect(fake.driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(1);
      await say(phone, '/pair off');
      expect(fake.driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(0);
    });
  });

  // -- missed calls in the digest (ROADMAP #20, 2026-10-06) ---------------------

  describe('missed calls in the digest', () => {
    const askPushes = () => google.pushes.filter((push) => push['kind'] === 'calls_report');
    const report = async (phone: FakePhone, calls: { name?: string; at: number }[]) =>
      send(await phone.toDo('POST', '/app/calls-report', { calls }));

    const readyPhone = async () => {
      const phone = await pair();
      await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['calls_report'] }));
      repo.setDigestHour(12);
      return phone;
    };

    /** Run the digest until it has asked the phone, and hand back the running promise. */
    const startDigest = async () => {
      const running = assistant.maybeSendDigest();
      // Real time passes too: signing the push's token is real crypto.
      await vi.waitFor(() => expect(askPushes()).toHaveLength(1), { timeout: 4_000, interval: 10 });
      // Wrapped: an async function returning a promise would wait for it.
      return { running };
    };

    it('refuses a report nobody asked for, and keeps nothing', async () => {
      const phone = await readyPhone();
      expect((await report(phone, [{ name: 'דנה', at: NOW - 60_000 }])).status).toBe(409);
      expect(fake.driver.exec('SELECT COUNT(*) AS n FROM missed_calls')[0]?.['n']).toBe(0);
    });

    it('asks with an empty push, puts the answer in the digest, and keeps no name afterwards', async () => {
      const phone = await readyPhone();
      const { running } = await startDigest();
      expect(askPushes()).toEqual([{ kind: 'calls_report' }]);

      expect((await report(phone, [{ name: 'דנה', at: NOW - 3_600_000 }, { at: NOW - 7_200_000 }])).status).toBe(200);
      await vi.advanceTimersByTimeAsync(1_000);
      await running;

      const digest = (await outbox(phone)).rows.find((row) => row.kind === 'digest');
      expect(stripIsolates(digest!.text)).toContain('שיחות שלא נענו:');
      expect(stripIsolates(digest!.text)).toContain('• דנה · ');
      expect(stripIsolates(digest!.text)).toContain('• מספר לא מזוהה · ');
      expect(fake.driver.exec('SELECT COUNT(*) AS n FROM missed_calls')[0]?.['n']).toBe(0);
      // A late report is refused: the ask closed with the digest.
      expect((await report(phone, [{ name: 'דנה', at: NOW }])).status).toBe(409);
    });

    it('waits twenty seconds at most for a phone that does not answer', async () => {
      const phone = await readyPhone();
      reminders.schedule({ principal, text: 'לקנות חלב', dueAtUtc: NOW + 3_600_000, localWallTime: '', tz: 'Asia/Jerusalem' });
      const { running } = await startDigest();
      await vi.advanceTimersByTimeAsync(21_000);
      await running;
      const rows = (await outbox(phone)).rows;
      const digest = rows.find((row) => row.kind === 'digest');
      expect(stripIsolates(digest!.text)).toContain('לקנות חלב');
      expect(stripIsolates(digest!.text)).not.toContain('שיחות שלא נענו');
    });

    it('does not ask an app that did not say it can answer', async () => {
      const phone = await pair();
      await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'tok', caps: ['cards'] }));
      repo.setDigestHour(12);
      await assistant.maybeSendDigest();
      expect(askPushes()).toEqual([]);
    });
  });
});
