/**
 * The log canary for the app channel (PLAN §6.9, §6.18): pair, write, record
 * and ack through the real Durable Object, then look for every secret and
 * every word of content in the log sink — and for the transcript anywhere in
 * the database.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { AssistantDO } from '../../src/platform/assistant-do.js';
import { createFakeDoState } from '../integration/fake-do-state.js';
import type { FakeDoState } from '../integration/fake-do-state.js';
import { FakePhone, FAKE_PUSH_TOKEN, createFakeGoogle, createServiceAccount, messageId } from '../integration/fake-phone.js';
import type { AppEnv } from '../../src/core/env.js';

const CANARY = 'CANARY-5d1e77b0-do-not-log';
const SPOKEN = 'עזרה CANARY-VOICE-2b9c';
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';
const GEMINI_KEY = 'CANARY-GEMINI-KEY-not-real';
const NOW = Date.parse('2026-09-29T09:00:00Z');

let serviceAccount: string;
beforeAll(async () => {
  serviceAccount = await createServiceAccount();
});

describe('log canary, app channel', () => {
  let written: string[];
  let fake: FakeDoState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    written = [];
    fake = createFakeDoState();
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
  });
  afterEach(() => {
    fake.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs no content, no pairing secret, no key, no push address and no signature', async () => {
    const google = createFakeGoogle();
    google.transcript = SPOKEN;
    const env: AppEnv = {
      ENVIRONMENT: 'test',
      WA_APP_SECRET: '',
      WA_VERIFY_TOKEN: '',
      WA_ACCESS_TOKEN: '',
      ALLOWLIST_WA_IDS: '972500000000',
      GROQ_API_KEY: 'test-key-not-real',
      GEMINI_API_KEY: GEMINI_KEY,
      GOOGLE_CLIENT_SECRET: 'x',
      TOKEN_ENC_KEY_V1: Buffer.alloc(32, 9).toString('base64'),
      LOG_HASH_KEY: 'test-key',
      DEVICE_TOKEN_PEPPER: 'test-pepper-not-a-real-secret',
      FCM_SA_KEY: serviceAccount,
      PAIR_BOOTSTRAP_CODE: BOOTSTRAP,
      CHANNEL: 'app',
      WA_PHONE_NUMBER_ID: '',
      GOOGLE_CLIENT_ID: 'x',
      PUBLIC_BASE_URL: 'https://assistant.example.test',
    };
    const assistant = new AssistantDO(fake.state as never, env, google.fetchImpl);
    await Promise.resolve();

    const phone = new FakePhone();
    const pairing = await phone.pairToDo(BOOTSTRAP);
    const mac = String((JSON.parse(await pairing.clone().text()) as { mac: string }).mac);
    const paired = (await (await assistant.fetch(pairing)).json()) as { deviceId: string };
    phone.deviceId = paired.deviceId;

    const text = await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: CANARY });
    const signature = text.headers.get('x-signature')!;
    const nonce = text.headers.get('x-nonce')!;
    await assistant.fetch(text);

    const voice = await phone.toDo('POST', `/app/voice/${messageId()}`, new Uint8Array([1, 2, 3]), {
      contentType: 'audio/mp4',
    });
    const answer = (await (await assistant.fetch(voice)).json()) as { row: { text: string } };
    expect(answer.row.text).toContain('CANARY-VOICE-2b9c'); // the echo is in the response…

    // A message refused for its conversation's mode logs no more than any other.
    const conversationId = '11111111-1111-4111-8111-111111111111';
    await assistant.fetch(await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: CANARY, conversationId, mode: 'smart' }));
    const refused = await assistant.fetch(
      await phone.toDo('POST', '/app/message', { id: messageId(), kind: 'text', text: CANARY, conversationId, mode: 'local' }),
    );
    expect(refused.status).toBe(422);

    const all = written.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [CANARY, 'CANARY-VOICE-2b9c', GEMINI_KEY, BOOTSTRAP.replace(/-/g, ''), BOOTSTRAP, mac, phone.publicKey, FAKE_PUSH_TOKEN, signature, nonce]) {
      expect(all).not.toContain(secret);
    }

    // …and nowhere at rest: not in the outbox, not in any table.
    const tables = fake.driver
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => String(row['name']));
    const dump = tables.map((table) => JSON.stringify(fake.driver.exec(`SELECT * FROM ${table}`))).join('\n');
    expect(dump).not.toContain('CANARY-VOICE-2b9c');
    expect(dump).not.toContain(BOOTSTRAP.replace(/-/g, ''));
    expect(dump).not.toContain(FAKE_PUSH_TOKEN);
  });
});
