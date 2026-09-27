/**
 * Worker entry. Its job is to get untrusted requests validated and handed to
 * the Durable Object as fast as possible, then return 200 so Meta does not
 * retry (PLAN §3.2).
 *
 * The ingress order is fixed and must not be rearranged:
 *   raw body -> HMAC -> parse -> allowlist -> dedupe   (CLAUDE.md invariant 9)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './core/env.js';
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
  const id = c.req.query('id') ?? '';
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
  return c.text('Connected. You can close this page and return to WhatsApp.', 200);
});

/**
 * The device companion's routes (PLAN §6.17).
 *
 * Public, because a phone reaches them over the internet, and trusted only as
 * far as the credential presented: a single-use pairing code, or the device
 * token it was traded for. Everything is checked inside the Durable Object,
 * where the token's hash lives; this layer only refuses what is malformed.
 *
 * A device token can fetch a dispatch, report on one, and update its own push
 * address — nothing else. No route here reads a reminder, the calendar, or a
 * setting. Failures say as little as the OAuth pages do.
 */
const MAX_DEVICE_BODY_BYTES = 4_096;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const DISPATCH_ID = /^[0-9a-f]{32}$/;

const pairBody = z
  .object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), pushToken: z.string().min(1).max(4_096) })
  .strict();
const reportBody = z
  .object({
    dispatchId: z.string().regex(DISPATCH_ID),
    matched: z.enum(['none', 'one', 'many']),
    outcome: z.enum(['placed', 'cancelled', 'no_match']),
  })
  .strict();
const pushTokenBody = z.object({ pushToken: z.string().min(1).max(4_096) }).strict();

async function deviceJson<T>(c: { req: { text(): Promise<string> } }, schema: z.ZodType<T>): Promise<T | null> {
  const raw = await c.req.text();
  if (raw.length > MAX_DEVICE_BODY_BYTES) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function bearerOf(header: string | undefined): string | null {
  return BEARER.exec(header ?? '')?.[1] ?? null;
}

app.post('/device/pair', async (c) => {
  const body = await deviceJson(c, pairBody);
  if (!body) return c.text('bad request', 400);

  const result = await callDo<{ deviceToken?: string; error?: string }>(c.env, '/do/device/pair', body);
  if (!result?.deviceToken) {
    log.warn('device_pair_rejected', { errorCode: result?.error ?? 'unknown' });
    return c.text('invalid or expired code', 400);
  }
  return c.json({ deviceToken: result.deviceToken });
});

app.get('/device/dispatch/:id', async (c) => {
  const token = bearerOf(c.req.header('authorization'));
  const id = c.req.param('id');
  if (!token) return c.text('unauthorized', 401);
  if (!DISPATCH_ID.test(id)) return c.text('not found', 404);

  const result = await callDo<{ queryVariants?: string[]; expiresAt?: number; error?: string }>(
    c.env,
    '/do/device/dispatch',
    { token, id },
  );
  if (result?.error === 'unauthorized') return c.text('unauthorized', 401);
  if (!result?.queryVariants) return c.text('not found', 404);
  return c.json({ queryVariants: result.queryVariants, expiresAt: result.expiresAt });
});

app.post('/device/report', async (c) => {
  const token = bearerOf(c.req.header('authorization'));
  if (!token) return c.text('unauthorized', 401);
  const body = await deviceJson(c, reportBody);
  if (!body) return c.text('bad request', 400);

  const result = await callDo<{ ok?: boolean; error?: string }>(c.env, '/do/device/report', { token, ...body });
  if (result?.error === 'unauthorized') return c.text('unauthorized', 401);
  if (!result?.ok) return c.text('not found', 404);
  return c.body(null, 204);
});

app.post('/device/push-token', async (c) => {
  const token = bearerOf(c.req.header('authorization'));
  if (!token) return c.text('unauthorized', 401);
  const body = await deviceJson(c, pushTokenBody);
  if (!body) return c.text('bad request', 400);

  const result = await callDo<{ ok?: boolean }>(c.env, '/do/device/push-token', { token, ...body });
  if (!result?.ok) return c.text('unauthorized', 401);
  return c.body(null, 204);
});

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
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName('singleton'));
    const path = event.cron === HOURLY_CRON ? '/do/tick' : '/do/maintenance';
    ctx.waitUntil(stub.fetch(`https://do${path}`, { method: 'POST' }));
  },
};
