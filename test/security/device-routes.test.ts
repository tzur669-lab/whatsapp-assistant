/**
 * The app and call routes at the Worker (PLAN §6.17, §6.18). This layer checks
 * only what can be checked without a key — route, channel, shape, size — and
 * then hands the body on byte for byte, because the signature covers those
 * exact bytes. The credential is the Durable Object's to check.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import app from '../../src/index.js';

type Reached = { headers: Record<string, string>; body: Uint8Array };

let reached: Reached[];
let answer: { status: number; body: unknown };

function makeEnv(channel?: string) {
  const stub = {
    fetch: async (_url: string, init: { headers: Headers; body: Uint8Array }) => {
      const headers: Record<string, string> = {};
      init.headers.forEach((value, name) => {
        headers[name] = value;
      });
      reached.push({ headers, body: new Uint8Array(init.body) });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    },
  };
  return {
    ENVIRONMENT: 'test',
    ...(channel === undefined ? {} : { CHANNEL: channel }),
    ASSISTANT: { idFromName: () => 'id', get: () => stub },
  } as unknown as Parameters<typeof app.fetch>[1];
}

const SIGNED = {
  'x-device-id': '0123456789abcdef0123456789abcdef',
  'x-timestamp': '1790000000000',
  'x-nonce': 'fedcba9876543210fedcba9876543210',
  'x-signature': 'MAYCAQECAQE=',
};

const request = (path: string, init: RequestInit, channel = 'app') =>
  app.fetch(new Request(`https://w.example.test${path}`, init), makeEnv(channel));

const postJson = (path: string, body: string, channel = 'app', extra: Record<string, string> = {}) =>
  request(path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...SIGNED, ...extra } }, channel);

beforeEach(() => {
  reached = [];
  answer = { status: 200, body: { status: 'reply' } };
});

describe('which routes exist', () => {
  it('serves the assistant only when the app is the channel', async () => {
    expect((await postJson('/app/message', '{}', 'app')).status).toBe(200);
    expect((await postJson('/app/message', '{}', 'whatsapp')).status).toBe(404);
    expect((await postJson('/app/message', '{}', 'off')).status).toBe(404);
  });

  it('serves pairing and the call routes on WhatsApp too, and on nothing when off', async () => {
    expect((await postJson('/app/pair', '{}', 'whatsapp')).status).toBe(200);
    expect((await request(`/device/dispatch/${'f'.repeat(32)}`, { headers: SIGNED }, 'whatsapp')).status).toBe(200);
    expect((await postJson('/app/pair', '{}', 'off')).status).toBe(404);
  });

  it('treats an unset channel as WhatsApp, as before', async () => {
    const response = await app.fetch(
      new Request('https://w.example.test/app/message', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      makeEnv(undefined),
    );
    expect(response.status).toBe(404);
  });

  it('closes the WhatsApp webhook when the app is the channel', async () => {
    expect((await request('/wa/webhook', { method: 'POST', body: '{}' }, 'app')).status).toBe(404);
    expect((await request('/wa/webhook?hub.mode=subscribe', { method: 'GET' }, 'off')).status).toBe(404);
  });

  it('closes the OAuth pair with the kill switch on', async () => {
    expect((await request(`/oauth/google/start?id=${'a'.repeat(64)}`, { method: 'GET' }, 'off')).status).toBe(404);
  });

  it('refuses an id that is not one it could have issued, without reaching the DO', async () => {
    expect((await request('/device/dispatch/../../do/maintenance', { headers: SIGNED })).status).toBe(404);
    expect(reached).toHaveLength(0);
  });
});

describe('what never reaches the Durable Object', () => {
  it('a body over the cap, whether declared or not', async () => {
    expect((await postJson('/app/message', 'x'.repeat(17_000))).status).toBe(413);

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(1_000));
        controller.close();
      },
    });
    const response = await request('/app/message', {
      method: 'POST',
      body: streamed,
      headers: { 'content-type': 'application/json', ...SIGNED },
      // @ts-expect-error — Node needs this for a streamed request body.
      duplex: 'half',
    });
    expect(response.status).toBe(413);
    expect(reached).toHaveLength(0);
  });

  it('a phone-read result over 32 KB, and one on the WhatsApp channel (§6.21)', async () => {
    expect((await postJson('/app/device-result', 'x'.repeat(33_000))).status).toBe(413);
    expect((await postJson('/app/device-result', '{}', 'whatsapp')).status).toBe(404);
    expect(reached).toHaveLength(0);
    expect((await postJson('/app/device-result', '{}')).status).toBe(200);
  });

  it('a recording over a megabyte', async () => {
    const response = await request(`/app/voice/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e`, {
      method: 'POST',
      body: new Uint8Array(1024 * 1024 + 1),
      headers: { 'content-type': 'audio/mp4', ...SIGNED },
    });
    expect(response.status).toBe(413);
  });

  it('the wrong content type, and any compression', async () => {
    expect((await postJson('/app/message', '{}', 'app', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await postJson('/app/message', '{}', 'app', { 'content-encoding': 'gzip' })).status).toBe(415);
    const voice = await request(`/app/voice/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e`, {
      method: 'POST',
      body: new Uint8Array(4),
      headers: { 'content-type': 'image/png', ...SIGNED },
    });
    expect(voice.status).toBe(415);
    expect(reached).toHaveLength(0);
  });

  it('a query string, which the signature does not cover', async () => {
    expect((await request('/app/outbox?all=1', { headers: SIGNED })).status).toBe(400);
    expect(reached).toHaveLength(0);
  });
});

describe('what does', () => {
  it('the exact bytes, the signed headers, and the method and path checked', async () => {
    const body = '{"id":"3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e", "kind":"text","text":"שלום"}';
    await postJson('/app/message', body);

    expect(reached).toHaveLength(1);
    expect(new TextDecoder().decode(reached[0]!.body)).toBe(body);
    expect(reached[0]!.headers).toMatchObject({
      'x-app-method': 'POST',
      'x-app-path': '/app/message',
      'x-app-content-type': 'application/json',
      ...SIGNED,
    });
  });

  it('passes the Durable Object’s answer and status through, never cached', async () => {
    answer = { status: 409, body: { error: 'replay' } };
    const response = await postJson('/app/message', '{}');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'replay' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
