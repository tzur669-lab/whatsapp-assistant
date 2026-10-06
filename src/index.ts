/**
 * Worker entry. Its job is to get untrusted requests validated and handed to
 * the Durable Object as fast as possible (PLAN §3.2).
 *
 * The ingress order is fixed and must not be rearranged (CLAUDE.md invariant 9):
 *   WhatsApp: raw body -> HMAC -> parse -> allowlist -> dedupe
 *   the app:  route + size (here) -> signature -> device + nonce -> parse -> dedupe (in the DO)
 *
 * `CHANNEL` decides which exist (§6.18). `off` is the kill switch: every
 * channel route, and the OAuth pair, answers 404.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from './core/env.js';
import { channelOf } from './core/env.js';
import { checkAppRequest } from './channels/app/ingress.js';
import { verifyWebhookHandshake, verifyWebhookSignature } from './channels/whatsapp/verify.js';
import { parseWebhookPayload } from './channels/whatsapp/parse.js';
import { isAllowed, parseAllowlist } from './security/allowlist.js';
import { createLogger } from './security/redact.js';
import { MAX_WEBHOOK_BODY_BYTES } from './channels/whatsapp/limits.js';

export { AssistantDO } from './platform/assistant-do.js';

type Bindings = AppEnv & { ASSISTANT: DurableObjectNamespace };

const app = new Hono<{ Bindings: Bindings }>();
const log = createLogger({ component: 'worker' });

/** Public liveness probe. Returns nothing about the system's state. */
app.get('/health', (c) => c.text('ok'));

app.get('/wa/webhook', (c) => {
  if (channelOf(c.env) !== 'whatsapp') return c.text('not found', 404);
  const result = verifyWebhookHandshake(
    {
      mode: c.req.query('hub.mode'),
      token: c.req.query('hub.verify_token'),
      challenge: c.req.query('hub.challenge'),
    },
    c.env.WA_VERIFY_TOKEN,
  );

  if (!result.ok) {
    log.warn('handshake_rejected', {});
    return c.text('forbidden', 403);
  }
  return c.text(result.challenge, 200);
});

app.post('/wa/webhook', async (c) => {
  if (channelOf(c.env) !== 'whatsapp') return c.text('not found', 404);

  // 1. Raw body. The signature covers these exact bytes.
  const rawBody = await c.req.text();
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    log.warn('body_too_large', { bytes: rawBody.length });
    return c.text('payload too large', 413);
  }

  // 2. HMAC, before any parsing.
  const signature = await verifyWebhookSignature(
    rawBody,
    c.req.header('x-hub-signature-256'),
    c.env.WA_APP_SECRET,
  );
  if (!signature.ok) {
    log.warn('signature_rejected', { errorCode: signature.reason });
    return c.text('forbidden', 403);
  }

  // 3. Parse.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('malformed_json', {});
    return c.text('bad request', 400);
  }

  const events = parseWebhookPayload(payload);

  // 4. Allowlist. Unknown senders are dropped silently — no reply, no LLM call.
  const allowlist = parseAllowlist(c.env.ALLOWLIST_WA_IDS);
  const accepted = events.filter((event) => {
    if (event.kind === 'status') return true;
    if (isAllowed(event.from, allowlist)) return true;
    log.warn('sender_dropped', { wamid: event.wamid });
    return false;
  });

  // 5. Hand off to the DO, which dedupes and does the work. Meta gets its 200
  //    immediately either way; a slow handler here would trigger retries.
  if (accepted.length > 0) {
    const stub = c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName('singleton'));
    c.executionCtx.waitUntil(
      Promise.all(
        accepted.map((event) =>
          stub.fetch('https://do/do/inbound', {
            method: 'POST',
            body: JSON.stringify(event),
          }),
        ),
      ).catch((error: unknown) => {
        log.error('handoff_failed', {
          errorCode: error instanceof Error ? error.name : 'E_UNKNOWN',
        });
      }),
    );
  }

  return c.body(null, 200);
});

/**
 * The OAuth redirect pair (PLAN §6.6).
 *
 * Both are public — Google's consent flow arrives through a browser, not
 * through the webhook — so neither trusts anything but the one-time id it was
 * given. The id and the `state` are the only credentials, both are 256 random
 * bits, and both are consumed inside the Durable Object where the check and the
 * consumption are one statement.
 *
 * Replies are plain text with no detail: these pages are reachable by anyone
 * with the URL, and "which of link/state was wrong" is not worth telling them.
 */
app.get('/oauth/google/start', async (c) => {
  if (channelOf(c.env) === 'off') return c.text('not found', 404);
  // The reply shows the URL inside Hebrew text, wrapped in direction isolates
  // (FSI ... PDI). A phone's link detection can take the closing one along; it
  // is not part of the id, and what is left must still be exactly 64 hex digits.
  const id = (c.req.query('id') ?? '').replace(/[⁦-⁩]/g, '');
  if (!/^[0-9a-f]{64}$/.test(id)) {
    log.warn('oauth_start_rejected', { errorCode: 'malformed_id' });
    return c.text('invalid or expired link', 400);
  }

  const result = await callDo<{ redirectUrl?: string; error?: string }>(c.env, '/do/oauth/start', {
    linkId: id,
  });

  if (!result?.redirectUrl) {
    log.warn('oauth_start_rejected', { errorCode: result?.error ?? 'unknown' });
    return c.text('invalid or expired link', 400);
  }
  return c.redirect(result.redirectUrl, 302);
});

app.get('/oauth/google/callback', async (c) => {
  if (channelOf(c.env) === 'off') return c.text('not found', 404);
  // The user pressed Cancel on the consent screen.
  if (c.req.query('error')) {
    log.info('oauth_declined', {});
    return c.text('Access was not granted. You can close this page.', 200);
  }

  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  if (!code || !/^[0-9a-f]{64}$/.test(state)) {
    log.warn('oauth_callback_rejected', { errorCode: 'malformed' });
    return c.text('invalid request', 400);
  }

  const result = await callDo<{ ok?: boolean; error?: string }>(c.env, '/do/oauth/callback', {
    code,
    state,
  });

  if (!result?.ok) {
    log.warn('oauth_callback_rejected', { errorCode: result?.error ?? 'unknown' });
    return c.text('Could not complete the connection. Please request a new link.', 400);
  }
  return c.text('Connected. You can close this page and return to the assistant.', 200);
});

/**
 * The app's routes, and the call companion's (PLAN §6.17, §6.18).
 *
 * Public, because a phone reaches them over the internet, and trusted only as
 * far as the signature: checked in the Durable Object, where the keys live.
 * This layer refuses what is malformed or too big, and passes the body on
 * byte for byte — re-serialising it would change what was signed.
 */
const SIGNED_HEADERS = ['x-device-id', 'x-timestamp', 'x-nonce', 'x-signature'] as const;

async function forwardToApp(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const checked = await checkAppRequest(c.req.raw, channelOf(c.env));
  if (!checked.ok) {
    if (checked.status !== 404) log.warn('app_request_refused', { status: checked.status });
    return c.text(checked.status === 404 ? 'not found' : 'bad request', checked.status);
  }

  const headers = new Headers({
    'x-app-method': checked.method,
    'x-app-path': checked.path,
    'x-app-content-type': checked.contentType,
  });
  for (const name of SIGNED_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }

  const stub = c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName('singleton'));
  const pending = stub.fetch('https://do/do/app', { method: 'POST', headers, body: checked.body });

  // If the phone drops the connection mid-turn, the turn still finishes and its
  // answer still reaches the outbox (§6.18).
  try {
    c.executionCtx.waitUntil(pending.then(
      () => undefined,
      () => undefined,
    ));
  } catch {
    // No execution context outside the runtime (tests). Nothing to extend.
  }

  try {
    const response = await pending;
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (error) {
    log.error('do_call_failed', { errorCode: error instanceof Error ? error.name : 'E_UNKNOWN' });
    return c.text('unavailable', 503);
  }
}

app.on(['GET', 'POST'], ['/app/*', '/device/*'], forwardToApp);

app.notFound((c) => c.text('not found', 404));

async function callDo<T>(env: Bindings, path: string, body: unknown): Promise<T | null> {
  const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName('singleton'));
  try {
    const response = await stub.fetch(`https://do${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch (error) {
    log.error('do_call_failed', { errorCode: error instanceof Error ? error.name : 'E_UNKNOWN' });
    return null;
  }
}

/** Must match `triggers.crons` in `wrangler.jsonc`, exactly. */
const HOURLY_CRON = '0 * * * *';

export default {
  fetch: app.fetch,

  /**
   * Two schedules, told apart by the expression that fired (PLAN §6.7, §6.12).
   *
   * The hourly one exists because the digest hour is a setting and a cron
   * expression is not: the schedule is dumb and the Durable Object decides
   * whether this is the hour. Anything unrecognised runs maintenance, so a cron
   * added to the config and forgotten here still does something sane.
   */
  async scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
    const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName('singleton'));
    const path = event.cron === HOURLY_CRON ? '/do/tick' : '/do/maintenance';
    // Awaited, not left to `waitUntil` (2026-10-06): the digest may wait up to
    // twenty seconds for the phone's missed calls, after it is marked done, and
    // a cut-off there would lose the day's digest. A cron is never retried.
    try {
      await stub.fetch(`https://do${path}`, { method: 'POST' });
    } catch (error) {
      log.error('cron_do_failed', { errorCode: error instanceof Error ? error.name : 'E_UNKNOWN' });
    }
  },
};
