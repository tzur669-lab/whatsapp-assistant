/**
 * The learning notice through the real Durable Object (block K, K1): the
 * `/learn on` reply's own outbox row is the notice; only the phone's ack of
 * that row starts collecting; an unacked notice expires and the hourly tick
 * queues it once more.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState } from '../../integration/fake-do-state.js';
import type { FakeDoState } from '../../integration/fake-do-state.js';
import { FakePhone, createFakeGoogle, createServiceAccount, messageId } from '../../integration/fake-phone.js';
import type { FakeGoogle } from '../../integration/fake-phone.js';
import { LEARN_NOTICE_VERSION, LearnStore } from '../../../src/core/learn-store.js';
import { Repository } from '../../../src/core/repo.js';
import { OTHER_ROW_TTL_MS } from '../../../src/channels/app/outbox.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import type { AppEnv } from '../../../src/core/env.js';

const NOW = Date.parse('2026-10-14T09:00:00Z');
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

type Row = { seq: number; text: string };
type Answer = { status: string; row?: Row; rows?: Row[] };

describe('the learning notice in the app', () => {
  let fake: FakeDoState;
  let google: FakeGoogle;
  let assistant: AssistantDO;
  let learn: LearnStore;

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

  const ack = (phone: FakePhone, seqs: number[]) => phone.toDo('POST', '/app/outbox/ack', { seqs }).then(send);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    google = createFakeGoogle();
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
    learn = new LearnStore(fake.driver, new Repository(fake.driver), () => Date.now(), () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('collects only once the phone acked the notice row itself', async () => {
    const phone = await pair();
    const answer = await say(phone, '/learn on');
    expect(answer.status).toBe('reply');
    const seq = answer.row!.seq;
    expect(learn.state()).toMatchObject({ on: true, seen: null, sent: { version: LEARN_NOTICE_VERSION, seq } });
    expect(learn.collectable('miss')).toBe(false);

    await ack(phone, [seq + 100]);
    expect(learn.collectable('miss')).toBe(false);

    await ack(phone, [seq]);
    expect(learn.collectable('miss')).toBe(true);
    expect(learn.state()).toMatchObject({ seen: LEARN_NOTICE_VERSION, sent: null, since: NOW });
  });

  it('an unacked notice expires, and the next tick queues it once', async () => {
    const phone = await pair();
    const first = (await say(phone, '/learn on')).row!.seq;

    vi.setSystemTime(NOW + OTHER_ROW_TTL_MS + 1);
    await assistant.alarm();
    expect(learn.state().sent).toBeNull();

    await assistant.fetch(new Request('https://do/do/tick', { method: 'POST' }));
    const queued = learn.state().sent;
    expect(queued?.seq).toBeGreaterThan(first);
    await assistant.fetch(new Request('https://do/do/tick', { method: 'POST' }));
    expect(learn.state().sent).toEqual(queued);

    await ack(phone, [first]);
    expect(learn.collectable('miss')).toBe(false);
    await ack(phone, [queued!.seq]);
    expect(learn.collectable('miss')).toBe(true);
  });
  const started = async () => {
    const phone = await pair();
    const seq = (await say(phone, '/learn on')).row!.seq;
    await ack(phone, [seq]);
    expect(learn.collectable('weeks')).toBe(true);
    return phone;
  };
  const principalOf = () => String(fake.driver.exec('SELECT principal FROM inbound_messages LIMIT 1')[0]?.['principal']);
  const outboxTexts = async (phone: FakePhone) =>
    ((await send(await phone.toDo('GET', '/app/outbox'))).body as unknown as { rows: Array<{ text: string }> }).rows.map((r) => r.text);
  const tick = () => assistant.fetch(new Request('https://do/do/tick', { method: 'POST' }));

  it('the weekly review goes once, Sunday from 10:00, across the fall-back', async () => {
    const phone = await started();
    // 2026-10-25 is the fall-back Sunday: 09:30 local is 07:30Z, 10:30 is 08:30Z.
    vi.setSystemTime(Date.UTC(2026, 9, 25, 7, 30));
    await tick();
    expect((await outboxTexts(phone)).filter((t) => t.includes('סיכום הלמידה'))).toHaveLength(0);
    vi.setSystemTime(Date.UTC(2026, 9, 25, 8, 30));
    await Promise.all([tick(), tick()]);
    await tick();
    expect((await outboxTexts(phone)).filter((t) => t.includes('סיכום הלמידה'))).toHaveLength(1);
  });

  it('no review while learning is off', async () => {
    const phone = await started();
    await say(phone, '/learn off');
    vi.setSystemTime(Date.UTC(2026, 9, 25, 8, 30));
    await tick();
    expect((await outboxTexts(phone)).filter((t) => t.includes('סיכום הלמידה'))).toHaveLength(0);
  });

  it('a proposal button applies its stored value once; after /learn off it has expired', async () => {
    const phone = await started();
    const [row] = learn.insertGroup(principalOf(), [{ kind: 'leave_min', value: 20 }]);
    const tap = async (id: string, nonce: string) =>
      (await send(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'button', buttonId: `lp:${id}:${nonce}:ok` }))).body;
    expect((await tap(row!.id, row!.nonce)).row?.text).toContain('עודכן');
    expect(new Repository(fake.driver).leaveDefaultMinutes()).toBe(20);
    expect((await tap(row!.id, row!.nonce)).row?.text).toContain('כבר נענה');

    const [later] = learn.insertGroup(principalOf(), [{ kind: 'leave_min', value: 45 }]);
    await say(phone, '/learn off');
    expect((await tap(later!.id, later!.nonce)).row?.text).toContain('פג התוקף');
    expect(new Repository(fake.driver).leaveDefaultMinutes()).toBe(20);
  });

  it('the export answers the signed device only, never cached', async () => {
    const phone = await started();
    learn.addLeave(principalOf(), 25, true);
    learn.addLeave('p_other', 99, true);
    const response = await assistant.fetch(await phone.toDo('GET', '/app/learn/export'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { schema: number; leave: { count: number; medianStatedMinutes: number } };
    expect(body.schema).toBe(1);
    expect(body.leave).toMatchObject({ count: 1, medianStatedMinutes: 25 });

    const unsigned = await assistant.fetch(await phone.toDo('GET', '/app/learn/export', undefined, { unsigned: true }));
    expect(unsigned.status).toBe(401);
    const stranger = new FakePhone();
    stranger.deviceId = 'd'.repeat(32);
    expect((await assistant.fetch(await stranger.toDo('GET', '/app/learn/export'))).status).toBe(401);
  });
});
