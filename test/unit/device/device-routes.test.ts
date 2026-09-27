/**
 * The device companion through the Durable Object (PLAN §6.17): pair, fetch a
 * dispatch, report on it, and let one expire. The one reply per call goes out
 * here — when the phone reports, or when two minutes pass without it.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState, createFakeMeta } from '../../integration/fake-do-state.js';
import type { FakeDoState, FakeMeta } from '../../integration/fake-do-state.js';
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

describe('the device routes', () => {
  let fake: FakeDoState;
  let meta: FakeMeta;
  let assistant: AssistantDO;
  let store: DeviceStore;
  let principal: string;

  const call = async (path: string, body: unknown) => {
    const response = await assistant.fetch(
      new Request(`https://do/do/device/${path}`, { method: 'POST', body: JSON.stringify(body) }),
    );
    return (await response.json()) as Record<string, unknown>;
  };

  const pairPhone = async () => {
    const { code } = await store.createPairing(principal);
    const paired = await call('pair', { code, pushToken: 'fake-push-token' });
    const deviceId = store.activeDevice(principal)!.id;
    return { token: String(paired['deviceToken']), deviceId };
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

  it('pairs with a code, once', async () => {
    const { code } = await store.createPairing(principal);
    const first = await call('pair', { code, pushToken: 'fake-push-token' });
    expect(first['deviceToken']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await call('pair', { code, pushToken: 'fake-push-token' })).toEqual({ error: 'already_used' });
  });

  it('hands the phone the words to match, and nothing to a wrong token', async () => {
    const { token, deviceId } = await pairPhone();
    const { id } = store.createDispatch(principal, deviceId, ['דוד דני']);

    expect(await call('dispatch', { token: 'C'.repeat(43), id })).toEqual({ error: 'unauthorized' });
    expect(await call('dispatch', { token, id })).toEqual({
      queryVariants: ['דוד דני'],
      expiresAt: NOW + DISPATCH_TTL_MS,
    });
  });

  it('replies once, when the phone reports the call placed', async () => {
    const { token, deviceId } = await pairPhone();
    const { id } = store.createDispatch(principal, deviceId, ['דוד דני']);

    expect(await call('report', { token, dispatchId: id, matched: 'one', outcome: 'placed' })).toEqual({ ok: true });
    expect(await call('report', { token, dispatchId: id, matched: 'one', outcome: 'placed' })).toEqual({
      error: 'already_used',
    });

    expect(meta.sent.map((m) => stripIsolates(m.text))).toEqual(['יצאה שיחה.']);
    expect(meta.sent[0]!.to).toBe(SELF);
  });

  it('says there is no such contact when the phone found none', async () => {
    const { token, deviceId } = await pairPhone();
    const { id } = store.createDispatch(principal, deviceId, ['מישהו']);
    await call('report', { token, dispatchId: id, matched: 'none', outcome: 'no_match' });
    expect(meta.sent[0]!.text).toBe('אין איש קשר בשם הזה בטלפון.');
  });

  it('arms the alarm for the expiry, and reports an unanswered call once', async () => {
    const { deviceId } = await pairPhone();
    store.createDispatch(principal, deviceId, ['דוד דני']);

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
    const { deviceId } = await pairPhone();
    store.createDispatch(principal, deviceId, ['דוד דני']);
    new Repository(fake.driver).touchWindow(principal, Date.now());

    vi.setSystemTime(Date.parse('2026-09-26T09:00:00Z') + DISPATCH_TTL_MS);
    await assistant.alarm();
    expect(meta.sent).toHaveLength(1);
  });

  it('lets the phone update its push address, and only with its token', async () => {
    const { token, deviceId } = await pairPhone();
    expect(await call('push-token', { token, pushToken: 'rotated' })).toEqual({ ok: true });
    expect(await store.pushTokenOf(deviceId)).toBe('rotated');
    expect(await call('push-token', { token: 'D'.repeat(43), pushToken: 'x' })).toEqual({ error: 'unauthorized' });
  });

  it('refuses everything when the device pepper is not configured', async () => {
    const { DEVICE_TOKEN_PEPPER: _unset, ...withoutPepper } = ENV;
    const bare = new AssistantDO(fake.state as never, withoutPepper, meta.fetchImpl);
    const response = await bare.fetch(
      new Request('https://do/do/device/pair', { method: 'POST', body: JSON.stringify({ code: 'x' }) }),
    );
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });
});
