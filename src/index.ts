/**
 * Worker entry. Its job is to get untrusted requests validated and handed to
 * the Durable Object as fast as possible, then return 200 so Meta does not
 * retry (PLAN §3.2).
 *
 * The ingress order is fixed and must not be rearranged:
 *   raw body -> HMAC -> parse -> allowlist -> dedupe   (CLAUDE.md invariant 9)
 */
import { Hono } from 'hono';
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

app.notFound((c) => c.text('not found', 404));

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName('singleton'));
    ctx.waitUntil(stub.fetch('https://do/do/maintenance', { method: 'POST' }));
  },
};
