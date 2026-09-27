/**
 * The FCM sender (PLAN §6.17). No network: a fake fetch plays both Google's
 * token endpoint and FCM, and checks what each would see.
 *
 * What matters most is what the push carries — an opaque dispatch id and
 * nothing else, so a contact's name never reaches a third processor.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { FcmClient } from '../../../src/device/fcm.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://fcm.googleapis.com/v1/projects/test-project/messages:send';
const NOW = Date.parse('2026-09-27T12:00:00Z');

let serviceAccount: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const body = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n');
  serviceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'fcm-sender@test-project.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
  });
});

type Call = { url: string; init: RequestInit };

function fakeGoogle(sendStatus = 200) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === SEND_URL) {
      const body =
        sendStatus === 200
          ? { name: 'projects/test-project/messages/1' }
          : { error: { status: sendStatus === 404 ? 'NOT_FOUND' : 'INTERNAL' } };
      return new Response(JSON.stringify(body), { status: sendStatus });
    }
    return new Response('unexpected', { status: 599 });
  };
  return { calls, fetchImpl };
}

const decode = (part: string) =>
  JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;

describe('FcmClient', () => {
  it('pushes the dispatch id and nothing else', async () => {
    const google = fakeGoogle();
    const client = new FcmClient({ serviceAccountJson: serviceAccount, fetchImpl: google.fetchImpl, now: () => NOW });

    expect(await client.send('fake-registration-token', 'abc123')).toEqual({ ok: true });

    const send = google.calls.find((c) => c.url === SEND_URL)!;
    expect((send.init.headers as Record<string, string>)['authorization']).toBe('Bearer fake-access-token');
    expect(JSON.parse(String(send.init.body))).toEqual({
      message: {
        token: 'fake-registration-token',
        data: { dispatch_id: 'abc123' },
        android: { priority: 'HIGH', ttl: '120s' },
      },
    });
  });

  it('signs a JWT for the messaging scope that verifies against the key', async () => {
    const google = fakeGoogle();
    const client = new FcmClient({ serviceAccountJson: serviceAccount, fetchImpl: google.fetchImpl, now: () => NOW });
    await client.send('t', 'd');

    const form = new URLSearchParams(String(google.calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const [header, claims, signature] = form.get('assertion')!.split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(claims)).toEqual({
      iss: 'fcm-sender@test-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: TOKEN_URL,
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it('reuses the access token while it lasts, and fetches a new one after', async () => {
    let clock = NOW;
    const google = fakeGoogle();
    const client = new FcmClient({ serviceAccountJson: serviceAccount, fetchImpl: google.fetchImpl, now: () => clock });

    await client.send('t', 'd1');
    await client.send('t', 'd2');
    expect(google.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);

    clock += 3600_000;
    await client.send('t', 'd3');
    expect(google.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it('says so when the phone is no longer registered', async () => {
    const google = fakeGoogle(404);
    const client = new FcmClient({ serviceAccountJson: serviceAccount, fetchImpl: google.fetchImpl, now: () => NOW });
    expect(await client.send('t', 'd')).toEqual({ ok: false, reason: 'unregistered', status: 404 });
  });

  it('reports any other failure without throwing', async () => {
    const google = fakeGoogle(500);
    const client = new FcmClient({ serviceAccountJson: serviceAccount, fetchImpl: google.fetchImpl, now: () => NOW });
    expect(await client.send('t', 'd')).toEqual({ ok: false, reason: 'push_failed', status: 500 });

    const offline = new FcmClient({
      serviceAccountJson: serviceAccount,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      now: () => NOW,
    });
    expect(await offline.send('t', 'd')).toEqual({ ok: false, reason: 'push_failed' });
  });

  it('is not configured without a usable service account, and calls nobody', async () => {
    const google = fakeGoogle();
    for (const json of ['', 'not json', JSON.stringify({ client_email: 'x' })]) {
      const client = new FcmClient({ serviceAccountJson: json, fetchImpl: google.fetchImpl, now: () => NOW });
      expect(await client.send('t', 'd')).toEqual({ ok: false, reason: 'not_configured' });
    }
    expect(google.calls).toHaveLength(0);
  });
});
