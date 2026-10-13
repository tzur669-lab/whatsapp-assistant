/**
 * The phone's side of event-triggered reminders (block J, J4, PLAN §6.30),
 * through the Durable Object: the signed list, and a match that carries only
 * a watch id. Every request passes the app's ingress order (invariant 9).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState } from '../../integration/fake-do-state.js';
import type { FakeDoState } from '../../integration/fake-do-state.js';
import { FakePhone, createFakeGoogle, createServiceAccount } from '../../integration/fake-phone.js';
import type { FakeGoogle } from '../../integration/fake-phone.js';
import { WatchStore } from '../../../src/tools/watch-store.js';
import type { AppEnv } from '../../../src/core/env.js';
import { APP_ROUTES } from '../../../src/channels/app/ingress.js';

const NOW = Date.parse('2026-10-13T09:00:00Z');
const SELF = '972500000000';
const KEY = Buffer.alloc(32, 9).toString('base64');
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

const env = (): AppEnv => ({
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

describe('watches on the phone', () => {
  let fake: FakeDoState;
  let google: FakeGoogle;
  let assistant: AssistantDO;
  let watches: WatchStore;
  let principal: string;
  let phone: FakePhone;

  const send = async (request: Request) => {
    const response = await assistant.fetch(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const fired = async (watchId: string, matchedAt = Date.now(), from = phone) =>
    send(await from.toDo('POST', '/app/watch/fired', { watchId, matchedAt }));
  const scheduled = () => fake.driver.exec("SELECT text FROM reminders WHERE status = 'scheduled'");
  const create = (source: 'mail' | 'notification' | 'sms', said = ['חבילה!']) => {
    const made = watches.create({ principal, source, said, text: 'לאסוף את החבילה', repeat: false, expiresAt: NOW + 86_400_000 });
    if (!made.ok) throw new Error('full');
    return made.id;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    google = createFakeGoogle();
    assistant = new AssistantDO(fake.state as never, env(), google.fetchImpl);
    await Promise.resolve();
    watches = new WatchStore(fake.driver, () => Date.now());
    const { hashPrincipal } = await import('../../../src/security/redact.js');
    principal = await hashPrincipal(SELF, 'test-key');
    phone = new FakePhone();
    const paired = await send(await phone.pairToDo(BOOTSTRAP));
    expect(paired.status).toBe(200);
    phone.deviceId = String(paired.body['deviceId']);
  });
  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('the Worker lets both routes through, on the app channel only, size-capped', () => {
    const list = APP_ROUTES.find((route) => route.method === 'GET' && route.pattern.test('/app/watches'));
    const match = APP_ROUTES.find((route) => route.method === 'POST' && route.pattern.test('/app/watch/fired'));
    expect(list?.channels).toEqual(['app']);
    expect(match?.channels).toEqual(['app']);
    expect(match!.maxBytes).toBeLessThanOrEqual(1_024);
  });

  it('lists the phone-matched watches, keywords normalized, never the mail ones', async () => {
    const id = create('notification');
    create('mail');
    const listed = await send(await phone.toDo('GET', '/app/watches'));
    expect(listed.status).toBe(200);
    expect(listed.body['watches']).toEqual([{ id, source: 'notification', keywords: ['חבילה'], expiresAt: NOW + 86_400_000 }]);
  });

  it('a match schedules the reminder once; the same event again claims nothing', async () => {
    const id = create('sms');
    expect((await fired(id)).body).toEqual({ status: 'claimed' });
    expect((await fired(id)).body).toEqual({ status: 'none' });
    expect(scheduled()).toEqual([{ text: 'לאסוף את החבילה' }]);
  });

  it('refuses a stale or a future match, and a mail watch', async () => {
    const id = create('notification');
    expect((await fired(id, Date.now() - 11 * 60 * 1000)).body).toEqual({ status: 'stale' });
    expect((await fired(id, Date.now() + 3 * 60 * 1000)).body).toEqual({ status: 'stale' });
    expect((await fired(create('mail'))).body).toEqual({ status: 'none' });
    expect(scheduled()).toEqual([]);
  });

  it('an unknown device gets 401 and fires nothing', async () => {
    const id = create('notification');
    const stranger = new FakePhone();
    stranger.deviceId = 'd'.repeat(32);
    expect((await fired(id, Date.now(), stranger)).status).toBe(401);
    expect(scheduled()).toEqual([]);
  });

  it('a body with event text in it is refused', async () => {
    const id = create('notification');
    const response = await send(await phone.toDo('POST', '/app/watch/fired', { watchId: id, matchedAt: Date.now(), text: 'החבילה הגיעה' }));
    expect(response.status).toBe(400);
    expect(scheduled()).toEqual([]);
  });
});
