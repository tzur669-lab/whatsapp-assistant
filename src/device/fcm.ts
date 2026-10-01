/**
 * Push a call dispatch to the paired phone through FCM HTTP v1 (PLAN §6.17).
 *
 * The push carries an **opaque dispatch id and nothing else**. The app wakes,
 * fetches the dispatch over HTTPS with its own token, and only then learns the
 * words to match — so "דוד דני" never passes through a third processor.
 *
 * Authentication is a service account: an RS256 JWT signed with WebCrypto,
 * traded at Google's token endpoint for an hour-long access token that is held
 * in memory only. No SDK — a JWT and two fetches do not justify a dependency,
 * and the Workers CPU budget does not want one.
 *
 * Failures are returned, never thrown, and never carry Google's error text.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_LIFETIME_S = 3600;
/** Refresh a little early, so a token does not expire between check and use. */
const REFRESH_MARGIN_MS = 60_000;
/** The dispatch's own lifetime: a push delivered later than this is useless. */
const PUSH_TTL = '120s';
/**
 * "There is something in the outbox" (PLAN §6.18). Worth delivering for a
 * while — the row it points at waits up to a week — but the alarm pushes again
 * anyway, so a stale signal is not kept forever.
 */
const SIGNAL_TTL = '14400s';
const TIMEOUT_MS = 8_000;

export type PushResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'unregistered' | 'push_failed'; status?: number };

export type FcmConfig = {
  /** The service account's JSON key, as downloaded (`FCM_SA_KEY`). */
  serviceAccountJson: string;
  /** Overrides the key's own `project_id` (`FCM_PROJECT_ID`). */
  projectId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type ServiceAccount = { clientEmail: string; privateKeyPem: string; projectId: string };

export class FcmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly account: ServiceAccount | null;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(config: FcmConfig) {
    // Through a closure: Workers' `fetch` called as a method of this object
    // throws "Illegal invocation" (every call failed in staging, 2026-10-01).
    const doFetch = config.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => doFetch(input, init);
    this.now = config.now ?? (() => Date.now());
    this.account = parseServiceAccount(config.serviceAccountJson, config.projectId);
  }

  /** A call dispatch: its opaque id and nothing else (§6.17). */
  send(pushToken: string, dispatchId: string): Promise<PushResult> {
    return this.post(pushToken, { dispatch_id: dispatchId }, PUSH_TTL);
  }

  /**
   * Wake the app to fetch its outbox (§6.18). The message carries only its
   * kind: no text, no row id, nothing a reader at Google could learn from.
   */
  signal(pushToken: string): Promise<PushResult> {
    return this.post(pushToken, { kind: 'outbox' }, SIGNAL_TTL);
  }

  private async post(pushToken: string, data: Record<string, string>, ttl: string): Promise<PushResult> {
    if (!this.account) return { ok: false, reason: 'not_configured' };

    try {
      const token = await this.token(this.account);
      if (!token) return { ok: false, reason: 'push_failed' };

      const response = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: pushToken,
              data,
              android: { priority: 'HIGH', ttl },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );

      if (response.ok) return { ok: true };
      // 404 NOT_FOUND / UNREGISTERED: the app was uninstalled or its token
      // rotated without telling us. Only the status is read.
      if (response.status === 404) return { ok: false, reason: 'unregistered', status: 404 };
      if (response.status === 401) this.accessToken = null;
      return { ok: false, reason: 'push_failed', status: response.status };
    } catch {
      return { ok: false, reason: 'push_failed' };
    }
  }

  private async token(account: ServiceAccount): Promise<string | null> {
    const now = this.now();
    if (this.accessToken && this.accessToken.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.accessToken.value;
    }

    const assertion = await signJwt(account, now);
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') return null;
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : TOKEN_LIFETIME_S;
    this.accessToken = { value: body.access_token, expiresAt: now + lifetime * 1000 };
    return body.access_token;
  }
}

function parseServiceAccount(json: string, projectOverride?: string): ServiceAccount | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKeyPem = record['private_key'];
  const projectId = projectOverride || record['project_id'];
  if (typeof clientEmail !== 'string' || typeof privateKeyPem !== 'string' || typeof projectId !== 'string') {
    return null;
  }
  if (!privateKeyPem.includes('PRIVATE KEY')) return null;
  return { clientEmail, privateKeyPem, projectId };
}

async function signJwt(account: ServiceAccount, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlJson({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
  });

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(account.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
