/**
 * The device routes at the Worker (PLAN §6.17). This layer only refuses what is
 * malformed — the credential itself is checked in the Durable Object — so these
 * tests are about what never gets that far, and about what the phone is told.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import app from '../../src/index.js';

const TOKEN = 'A'.repeat(43);
const DISPATCH = 'f'.repeat(32);

let reached: Array<{ path: string; body: Record<string, unknown> }>;
let answer: unknown;

function makeEnv() {
  const stub = {
    fetch: (url: string, init: { body?: string }) => {
      reached.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    },
  };
  return {
    ENVIRONMENT: 'test',
    ASSISTANT: { idFromName: () => 'id', get: () => stub },
  } as unknown as Parameters<typeof app.fetch>[1];
}

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://w.example.test${path}`, init), makeEnv());

const post = (path: string, body: unknown, token?: string) =>
  request(path, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  reached = [];
  answer = {};
});

describe('POST /device/pair', () => {
  it('trades a well-formed code for a device token', async () => {
    answer = { deviceToken: TOKEN };
    const response = await post('/device/pair', { code: 'B'.repeat(43), pushToken: 'push' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceToken: TOKEN });
  });

  it('says the same thing for every refused code', async () => {
    answer = { error: 'expired' };
    const refused = await post('/device/pair', { code: 'B'.repeat(43), pushToken: 'push' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('invalid or expired code');
  });

  it('never reaches the DO with a malformed body', async () => {
    for (const body of ['not json', { code: 'short', pushToken: 'p' }, { code: 'B'.repeat(43) }, { code: 'B'.repeat(43), pushToken: 'p', extra: 1 }]) {
      expect((await post('/device/pair', body)).status).toBe(400);
    }
    expect((await post('/device/pair', 'x'.repeat(5_000))).status).toBe(400);
    expect(reached).toHaveLength(0);
  });
});

describe('GET /device/dispatch/:id', () => {
  it('needs a bearer token of the right shape', async () => {
    expect((await request(`/device/dispatch/${DISPATCH}`)).status).toBe(401);
    const wrongShape = await request(`/device/dispatch/${DISPATCH}`, { headers: { authorization: 'Bearer short' } });
    expect(wrongShape.status).toBe(401);
    expect(reached).toHaveLength(0);
  });

  it('refuses an id that is not one it could have issued', async () => {
    const response = await request('/device/dispatch/../../do/maintenance', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(reached).toHaveLength(0);
  });

  it('returns the words to match, and passes the token only to the DO', async () => {
    answer = { queryVariants: ['דוד דני'], expiresAt: 1 };
    const response = await request(`/device/dispatch/${DISPATCH}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await response.json()).toEqual({ queryVariants: ['דוד דני'], expiresAt: 1 });
    expect(reached).toEqual([{ path: '/do/device/dispatch', body: { token: TOKEN, id: DISPATCH } }]);
  });

  it('answers 401 when the DO does not know the token', async () => {
    answer = { error: 'unauthorized' };
    const response = await request(`/device/dispatch/${DISPATCH}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(401);
  });
});

describe('POST /device/report', () => {
  const report = { dispatchId: DISPATCH, matched: 'one', outcome: 'placed' };

  it('accepts a count and an outcome', async () => {
    answer = { ok: true };
    expect((await post('/device/report', report, TOKEN)).status).toBe(204);
  });

  it('refuses a report that carries a name or a number', async () => {
    // The strict schema is what keeps "No number ever reaches the Worker" true
    // even for a buggy or hostile app: an extra field is a 400, not a log line.
    for (const extra of [{ name: 'דוד דני' }, { number: '0500000000' }]) {
      expect((await post('/device/report', { ...report, ...extra }, TOKEN)).status).toBe(400);
    }
    expect(reached).toHaveLength(0);
  });

  it('refuses an outcome outside the closed set', async () => {
    expect((await post('/device/report', { ...report, outcome: 'hacked' }, TOKEN)).status).toBe(400);
    expect((await post('/device/report', { ...report, matched: 2 }, TOKEN)).status).toBe(400);
  });

  it('needs the token', async () => {
    expect((await post('/device/report', report)).status).toBe(401);
    expect(reached).toHaveLength(0);
  });
});

describe('POST /device/push-token', () => {
  it('updates with the token, and says 401 otherwise', async () => {
    answer = { ok: true };
    expect((await post('/device/push-token', { pushToken: 'new' }, TOKEN)).status).toBe(204);
    answer = { error: 'unauthorized' };
    expect((await post('/device/push-token', { pushToken: 'new' }, TOKEN)).status).toBe(401);
  });
});
