/**
 * The call companion through the Durable Object, on the WhatsApp channel
 * (PLAN §6.17): pair with a `/pair` code, fetch a dispatch, report on it, and
 * let one expire. Every request after pairing is signed (§6.18) — the bearer
 * token is gone. The one reply per call goes out here, over WhatsApp.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState, createFakeMeta } from '../../integration/fake-do-state.js';
import type { FakeDoState, FakeMeta } from '../../integration/fake-do-state.js';
import { FakePhone } from '../../integration/fake-phone.js';
import { DeviceStore, DISPATCH_TTL_MS } from '../../../src/device/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { AppEnv } from '../../../src/core/env.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');

const ENV: AppEnv = {
  ENVIRONMENT: 'test',
  WA_APP_SECRET: 'x',
  WA_VERIFY_TOKEN: 'x',
  WA_ACCESS_TOKEN: 'x',
  ALLOWLIST_WA_IDS: SELF,
  GROQ_API_KEY: '',
  GOOGLE_CLIENT_SECRET: 'x',
  TOKEN_ENC_KEY_V1: KEY,
  LOG_HASH_KEY: 'test-key',
  DEVICE_TOKEN_PEPPER: 'test-pepper-not-a-real-secret',
  WA_PHONE_NUMBER_ID: 'PNID',
  GOOGLE_CLIENT_ID: 'x',
  PUBLIC_BASE_URL: 'https://assistant.example.test',
};

describe('the call routes on WhatsApp', () => {
  let fake: FakeDoState;
  let meta: FakeMeta;
  let assistant: AssistantDO;
  let store: DeviceStore;
  let principal: string;

  const send = async (request: Request) => {
    const response = await assistant.fetch(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const pairPhone = async () => {
    const phone = new FakePhone();
    const { code } = await store.createPairing(principal);
    const paired = await send(await phone.pairToDo(code));
    phone.deviceId = String(paired.body['deviceId']);
    return phone;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    fake = createFakeDoState();
    meta = createFakeMeta();
    assistant = new AssistantDO(fake.state as never, ENV, meta.fetchImpl);
    await Promise.resolve();

    store = new DeviceStore(
      fake.driver,
      () => Date.now(),
      () => ENV.DEVICE_TOKEN_PEPPER!,
      () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }),
    );
    const { hashPrincipal } = await import('../../../src/security/redact.js');
    principal = await hashPrincipal(SELF, ENV.LOG_HASH_KEY);
    new Repository(fake.driver).touchWindow(principal, NOW - 60_000);
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('pairs with a code, once — and only the phone that proved it', async () => {
    const phone = new FakePhone();
    const { code } = await store.createPairing(principal);
    const first = await send(await phone.pairToDo(code));
    expect(first.status).toBe(200);
    expect(first.body['deviceId']).toMatch(/^[0-9a-f]{32}$/);

    const stranger = await send(await new FakePhone().pairToDo(code));
    expect(stranger).toEqual({ status: 400, body: { error: 'invalid_code' } });
  });

  it('hands the phone the words to match, only on a valid signature', async () => {
    const phone = await pairPhone();
    const { id } = store.createDispatch(principal, phone.deviceId!, ['דוד דני']);

    expect(await send(await phone.toDo('GET', `/device/dispatch/${id}`))).toEqual({
      status: 200,
      body: { queryVariants: ['דוד דני'], expiresAt: NOW + DISPATCH_TTL_MS },
    });

    // Another phone's key, claiming this phone's id.
    const impostor = new FakePhone();
    impostor.deviceId = phone.deviceId;
    expect((await send(await impostor.toDo('GET', `/device/dispatch/${id}`))).status).toBe(401);
  });

  it('refuses the same signed request twice', async () => {
    const phone = await pairPhone();
    const { id } = store.createDispatch(principal, phone.deviceId!, ['דוד דני']);
    const nonce = 'c'.repeat(32);
    await send(await phone.toDo('GET', `/device/dispatch/${id}`, undefined, { nonce }));
    expect(await send(await phone.toDo('GET', `/device/dispatch/${id}`, undefined, { nonce }))).toEqual({
      status: 409,
      body: { error: 'replay' },
    });
  });

  it('replies once, when the phone reports the call placed', async () => {
    const phone = await pairPhone();
    const { id } = store.createDispatch(principal, phone.deviceId!, ['דוד דני']);
    const report = { dispatchId: id, matched: 'one', outcome: 'placed' };

    expect(await send(await phone.toDo('POST', '/device/report', report))).toEqual({ status: 200, body: { ok: true } });
    expect((await send(await phone.toDo('POST', '/device/report', report))).status).toBe(404);

    expect(meta.sent.map((m) => stripIsolates(m.text))).toEqual(['יצאה שיחה.']);
    expect(meta.sent[0]!.to).toBe(SELF);
  });

  it('refuses a report that carries a name or a number', async () => {
    const phone = await pairPhone();
    const { id } = store.createDispatch(principal, phone.deviceId!, ['מישהו']);
    const report = { dispatchId: id, matched: 'none', outcome: 'no_match', number: '0500000000' };
    expect((await send(await phone.toDo('POST', '/device/report', report))).status).toBe(400);
    expect(meta.sent).toHaveLength(0);
  });

  it('arms the alarm for the expiry, and reports an unanswered call once', async () => {
    const phone = await pairPhone();
    store.createDispatch(principal, phone.deviceId!, ['דוד דני']);

    await assistant.alarm();
    expect(fake.alarmAt()).toBe(NOW + DISPATCH_TTL_MS);
    expect(meta.sent).toHaveLength(0);

    vi.setSystemTime(NOW + DISPATCH_TTL_MS);
    await assistant.alarm();
    await assistant.alarm();
    expect(meta.sent.map((m) => m.text)).toEqual(['הטלפון לא היה זמין. לא יצאה שיחה.']);
  });

  it('does not hold a call reply for Shabbat', async () => {
    new Repository(fake.driver).setRestHold(true);
    vi.setSystemTime(Date.parse('2026-09-26T09:00:00Z')); // Saturday noon, local
    const phone = await pairPhone();
    store.createDispatch(principal, phone.deviceId!, ['דוד דני']);
    new Repository(fake.driver).touchWindow(principal, Date.now());

    vi.setSystemTime(Date.parse('2026-09-26T09:00:00Z') + DISPATCH_TTL_MS);
    await assistant.alarm();
    expect(meta.sent).toHaveLength(1);
  });

  it('lets the phone update its push address, signed', async () => {
    const phone = await pairPhone();
    expect(await send(await phone.toDo('POST', '/app/push-token', { pushToken: 'rotated' }))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await store.pushTokenOf(phone.deviceId!)).toBe('rotated');
  });

  it('does not serve the app’s own routes on WhatsApp', async () => {
    const phone = await pairPhone();
    expect((await send(await phone.toDo('GET', '/app/outbox'))).status).toBe(404);
  });

  it('refuses everything when the device pepper is not configured', async () => {
    const { DEVICE_TOKEN_PEPPER: _unset, ...withoutPepper } = ENV;
    const bare = new AssistantDO(fake.state as never, withoutPepper, meta.fetchImpl);
    const response = await bare.fetch(await new FakePhone().pairToDo('ABCD-EFGH-JKMN-PQRS-TVWX'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });
});
