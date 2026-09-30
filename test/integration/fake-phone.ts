/**
 * A paired phone, for tests: a P-256 key pair made the way the Android
 * Keystore makes one, and requests signed the way the app signs them
 * (PLAN §6.18). What reaches the Durable Object here is what the Worker would
 * forward — the raw body, the four signed headers, and the method and path it
 * checked.
 */
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalRequest, normalizePairingCode, pairingMac, sha256Hex } from '../../src/channels/app/verify.js';

export const FAKE_PUSH_TOKEN = 'fake-fcm-registration-token';

const encoder = new TextEncoder();

export class FakePhone {
  readonly publicKey: string;
  private readonly privateKey: KeyObject;
  deviceId: string | null = null;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    this.privateKey = privateKey;
  }

  /** The body of `POST /app/pair`: a MAC over this phone's key, never the code. */
  async pairBody(code: string, options: { pushToken?: string; timestamp?: number } = {}): Promise<Uint8Array> {
    const pushToken = options.pushToken ?? FAKE_PUSH_TOKEN;
    const timestamp = options.timestamp ?? Date.now();
    const normalized = normalizePairingCode(code) ?? code;
    const mac = await pairingMac(normalized, this.publicKey, pushToken, timestamp);
    return encoder.encode(JSON.stringify({ publicKey: this.publicKey, pushToken, timestamp, mac }));
  }

  async signedHeaders(
    method: string,
    path: string,
    body: Uint8Array,
    options: { timestamp?: number; nonce?: string; deviceId?: string } = {},
  ): Promise<Record<string, string>> {
    const deviceId = options.deviceId ?? this.deviceId;
    if (!deviceId) throw new Error('FakePhone is not paired');
    const timestamp = options.timestamp ?? Date.now();
    const nonce = options.nonce ?? randomBytes(16).toString('hex');

    const canonical = canonicalRequest({
      method,
      path,
      deviceId,
      timestamp,
      nonce,
      bodySha256Hex: await sha256Hex(body),
    });
    const signer = createSign('SHA256');
    signer.update(Buffer.from(canonical, 'utf8'));
    const signature = signer.sign({ key: this.privateKey, dsaEncoding: 'der' }).toString('base64');

    return {
      'x-device-id': deviceId,
      'x-timestamp': String(timestamp),
      'x-nonce': nonce,
      'x-signature': signature,
    };
  }

  /** A request as the Worker hands it to the Durable Object. */
  async toDo(
    method: 'GET' | 'POST',
    path: string,
    body: unknown = undefined,
    options: { contentType?: string; timestamp?: number; nonce?: string; unsigned?: boolean } = {},
  ): Promise<Request> {
    const bytes =
      body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : encoder.encode(JSON.stringify(body));
    const headers: Record<string, string> = {
      'x-app-method': method,
      'x-app-path': path,
      'x-app-content-type': options.contentType ?? (body === undefined ? '' : 'application/json'),
      ...(options.unsigned ? {} : await this.signedHeaders(method, path, bytes, options)),
    };
    return new Request('https://do/do/app', { method: 'POST', headers, body: bytes });
  }

  /** The pairing request as the Worker hands it on. Unsigned: the MAC is the proof. */
  async pairToDo(code: string, options: { pushToken?: string; timestamp?: number } = {}): Promise<Request> {
    const body = await this.pairBody(code, options);
    return new Request('https://do/do/app', {
      method: 'POST',
      headers: { 'x-app-method': 'POST', 'x-app-path': '/app/pair', 'x-app-content-type': 'application/json' },
      body,
    });
  }
}

/** A random, well-formed client message id. */
export function messageId(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A Firebase service account whose key really signs, and a fake Google that
 * plays both the token endpoint and FCM, recording what each push carried.
 */
export async function createServiceAccount(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const body = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n');
  return JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'fcm-sender@test-project.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
  });
}

export type FakeGoogle = {
  fetchImpl: typeof fetch;
  /** The `data` of every FCM message sent, in order. */
  pushes: Array<Record<string, string>>;
  /** Answer the next FCM sends with this status. */
  failPushes(status: number): void;
  /** A canned Whisper transcript, for `/audio/transcriptions`. */
  transcript: string | null;
  requests: string[];
};

export function createFakeGoogle(): FakeGoogle {
  const state: FakeGoogle = {
    fetchImpl: undefined as unknown as typeof fetch,
    pushes: [],
    failPushes(status: number) {
      pushStatus = status;
    },
    transcript: null,
    requests: [],
  };
  let pushStatus = 200;

  state.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    state.requests.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { message?: { data?: Record<string, string> } };
      state.pushes.push(body.message?.data ?? {});
      return new Response('{}', { status: pushStatus });
    }
    if (url.includes('/audio/transcriptions') && state.transcript !== null) {
      return new Response(
        JSON.stringify({
          text: state.transcript,
          language: 'hebrew',
          duration: 1.5,
          segments: [{ start: 0, end: 1.5, avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unexpected', { status: 599 });
  }) as unknown as typeof fetch;

  return state;
}
