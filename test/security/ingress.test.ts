/**
 * Ingress tests against the real Hono app (PLAN §11.4). No network: the DO
 * namespace is faked, so a request that reaches the DO is observable as a
 * recorded handoff.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import app from '../../src/index.js';
import { hmacSha256Hex } from '../../src/security/hmac.js';

const APP_SECRET = 'app-secret';
const VERIFY_TOKEN = 'verify-token';
const ALLOWED = '972500000000';
const FOREIGN = '972500000009';

let handedOff: unknown[];

function makeEnv() {
  const stub = {
    fetch: (_url: string, init: { body?: string }) => {
      handedOff.push(JSON.parse(init.body ?? '{}'));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  return {
    ENVIRONMENT: 'test',
    WA_APP_SECRET: APP_SECRET,
    WA_VERIFY_TOKEN: VERIFY_TOKEN,
    WA_ACCESS_TOKEN: 'token',
    ALLOWLIST_WA_IDS: ALLOWED,
    GROQ_API_KEY: '',
    GOOGLE_CLIENT_SECRET: '',
    TOKEN_ENC_KEY_V1: '',
    LOG_HASH_KEY: 'log-key',
    WA_PHONE_NUMBER_ID: 'PNID',
    GOOGLE_CLIENT_ID: '',
    ASSISTANT: { idFromName: () => 'id', get: () => stub },
  } as unknown as Parameters<typeof app.fetch>[1];
}

const waited: Promise<unknown>[] = [];
const executionCtx = {
  waitUntil: (p: Promise<unknown>) => void waited.push(p),
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function body(from = ALLOWED, text = '/ping'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PNID' },
              messages: [
                { from, id: `wamid.${text}`, timestamp: '1758700000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function post(raw: string, signature?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) {
    headers['x-hub-signature-256'] = signature ?? `sha256=${await hmacSha256Hex(APP_SECRET, raw)}`;
  }
  const res = await app.fetch(
    new Request('https://worker.test/wa/webhook', { method: 'POST', headers, body: raw }),
    makeEnv(),
    executionCtx,
  );
  await Promise.all(waited.splice(0));
  return res;
}

beforeEach(() => {
  handedOff = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('GET /wa/webhook', () => {
  const get = (qs: string) =>
    app.fetch(new Request(`https://worker.test/wa/webhook?${qs}`), makeEnv(), executionCtx);

  it('echoes the challenge on a correct handshake', async () => {
    const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('rejects a wrong verify token with 403', async () => {
    const res = await get('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345');
    expect(res.status).toBe(403);
  });

  it('rejects a missing mode', async () => {
    expect((await get(`hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`)).status).toBe(403);
  });
});

describe('POST /wa/webhook', () => {
  it('accepts a correctly signed message from an allowlisted sender', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(handedOff).toHaveLength(1);
    expect(handedOff[0]).toMatchObject({ kind: 'text', from: ALLOWED });
  });

  it('rejects a missing signature', async () => {
    const res = await post(body(), null);
    expect(res.status).toBe(403);
    expect(handedOff).toHaveLength(0);
  });

  it('rejects a bad signature', async () => {
    const res = await post(body(), 'sha256=deadbeef');
    expect(res.status).toBe(403);
    expect(handedOff).toHaveLength(0);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const raw = body();
    const res = await post(raw, `sha256=${await hmacSha256Hex('other', raw)}`);
    expect(res.status).toBe(403);
  });

  it('rejects a signature computed over re-serialized JSON', async () => {
    const raw = body();
    const reserialized = JSON.stringify(JSON.parse(raw));
    const spaced = `${reserialized} `;
    const res = await post(raw, `sha256=${await hmacSha256Hex(APP_SECRET, spaced)}`);
    expect(res.status).toBe(403);
  });

  it('drops a foreign sender silently: 200, no reply, no handoff', async () => {
    const res = await post(body(FOREIGN));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(handedOff).toHaveLength(0);
  });

  it('rejects a body over the size limit before verifying anything', async () => {
    const res = await post('x'.repeat(256 * 1024 + 1), 'sha256=deadbeef');
    expect(res.status).toBe(413);
  });

  it('returns 400 for malformed JSON that is correctly signed', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
  });

  it('accepts a signed payload with no messages without handing anything off', async () => {
    const res = await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
    expect(res.status).toBe(200);
    expect(handedOff).toHaveLength(0);
  });
});

describe('other routes', () => {
  it('serves /health with a bare ok', async () => {
    const res = await app.fetch(new Request('https://worker.test/health'), makeEnv(), executionCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('404s an unknown path', async () => {
    const res = await app.fetch(new Request('https://worker.test/admin'), makeEnv(), executionCtx);
    expect(res.status).toBe(404);
  });
});
