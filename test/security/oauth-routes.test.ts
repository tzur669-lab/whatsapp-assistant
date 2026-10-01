/**
 * The public OAuth routes (PLAN §6.6, §11.4).
 *
 * These two endpoints are reachable by anyone with the URL — Google's consent
 * flow comes back through a browser, not through the signed webhook. The only
 * credentials are the one-time link id and the `state`, both 256 random bits,
 * and the only jobs of these handlers are to check the shape, pass them to the
 * Durable Object, and say as little as possible about what went wrong.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import app from '../../src/index.js';

const HEX64 = 'a'.repeat(64);

let calls: { path: string; body: unknown }[];
let respond: (path: string, body: unknown) => unknown;

function makeEnv() {
  const stub = {
    fetch: (url: string, init: { body?: string }) => {
      const path = new URL(url).pathname;
      const parsed = JSON.parse(init.body ?? '{}');
      calls.push({ path, body: parsed });
      return Promise.resolve(
        new Response(JSON.stringify(respond(path, parsed)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
  return {
    ENVIRONMENT: 'test',
    WA_APP_SECRET: 'x',
    WA_VERIFY_TOKEN: 'x',
    WA_ACCESS_TOKEN: 'x',
    ALLOWLIST_WA_IDS: '972500000000',
    GROQ_API_KEY: '',
    GOOGLE_CLIENT_SECRET: 'x',
    TOKEN_ENC_KEY_V1: 'x',
    LOG_HASH_KEY: 'x',
    WA_PHONE_NUMBER_ID: 'PNID',
    GOOGLE_CLIENT_ID: 'x',
    PUBLIC_BASE_URL: 'https://assistant.example.test',
    ASSISTANT: { idFromName: () => 'id', get: () => stub },
  } as unknown as Parameters<typeof app.fetch>[1];
}

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const get = (path: string) =>
  app.fetch(new Request(`https://assistant.example.test${path}`), makeEnv(), executionCtx);

describe('/oauth/google/start', () => {
  beforeEach(() => {
    calls = [];
    respond = () => ({ redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
  });

  it('redirects to Google when the link is good', async () => {
    const response = await get(`/oauth/google/start?id=${HEX64}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('accounts.google.com');
  });

  it('accepts a link the chat app copied with the Hebrew text isolate attached', async () => {
    // The reply wraps the URL in FSI ... PDI; link detection on a phone can take the closing one along.
    for (const tail of ['⁩', '⁨⁩']) {
      const response = await get(`/oauth/google/start?id=${HEX64}${encodeURIComponent(tail)}`);
      expect(response.status).toBe(302);
    }
    expect(calls.every((call) => (call.body as { linkId: string }).linkId === HEX64)).toBe(true);
  });

  it('rejects a malformed id without troubling the Durable Object', async () => {
    for (const id of ['', 'short', `${HEX64}g`, '../etc', 'A'.repeat(64)]) {
      const response = await get(`/oauth/google/start?id=${encodeURIComponent(id)}`);
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('says the same thing whether the link was spent, expired or never issued', async () => {
    const said = new Set<string>();
    for (const reason of ['already_used', 'expired', 'not_found']) {
      respond = () => ({ error: reason });
      const response = await get(`/oauth/google/start?id=${HEX64}`);
      expect(response.status).toBe(400);
      said.add(await response.text());
    }
    // One message for all three: a page anyone can load is not an oracle.
    expect(said.size).toBe(1);
  });
});

describe('/oauth/google/callback', () => {
  beforeEach(() => {
    calls = [];
    respond = () => ({ ok: true });
  });

  it('confirms a completed connection', async () => {
    const response = await get(`/oauth/google/callback?code=abc&state=${HEX64}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Connected');
    expect(calls[0]?.body).toMatchObject({ code: 'abc', state: HEX64 });
  });

  it('answers calmly when the user declined on the consent screen', async () => {
    const response = await get('/oauth/google/callback?error=access_denied');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed state without an exchange', async () => {
    const response = await get('/oauth/google/callback?code=abc&state=nope');
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a callback with no code', async () => {
    const response = await get(`/oauth/google/callback?state=${HEX64}`);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('never echoes the code back into the page', async () => {
    respond = () => ({ error: 'invalid_grant' });
    const response = await get(`/oauth/google/callback?code=secret-code&state=${HEX64}`);
    expect(await response.text()).not.toContain('secret-code');
  });
});
