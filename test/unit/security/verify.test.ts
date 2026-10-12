import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../../src/security/hmac.js';
import { verifyWebhookSignature, verifyWebhookHandshake } from '../../../src/channels/whatsapp/verify.js';
import { MAX_WEBHOOK_BODY_BYTES } from '../../../src/channels/whatsapp/limits.js';

const APP_SECRET = 'app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-for-tests';

async function sign(body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(APP_SECRET, body)}`;
}

describe('verifyWebhookSignature (PLAN §11.4)', () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a correct signature over the raw body', async () => {
    const res = await verifyWebhookSignature(body, await sign(body), APP_SECRET);
    expect(res).toEqual({ ok: true });
  });

  it('rejects a missing signature header', async () => {
    const res = await verifyWebhookSignature(body, null, APP_SECRET);
    expect(res).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a header without the sha256= prefix', async () => {
    const bare = await hmacSha256Hex(APP_SECRET, body);
    const res = await verifyWebhookSignature(body, bare, APP_SECRET);
    expect(res).toEqual({ ok: false, reason: 'bad_signature_format' });
  });

  it('rejects a truncated signature', async () => {
    const full = await sign(body);
    const res = await verifyWebhookSignature(body, full.slice(0, 20), APP_SECRET);
    expect(res.ok).toBe(false);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const wrong = `sha256=${await hmacSha256Hex('other-secret', body)}`;
    const res = await verifyWebhookSignature(body, wrong, APP_SECRET);
    expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature computed over re-serialized JSON (raw body only)', async () => {
    // Meta signs the exact bytes it sent. Round-tripping through JSON changes them.
    const reserialized = JSON.stringify(JSON.parse(body).entry === undefined ? {} : JSON.parse(body));
    const spaced = '{"object": "whatsapp_business_account", "entry": []}';
    expect(spaced).not.toBe(body);
    const sigOverSpaced = `sha256=${await hmacSha256Hex(APP_SECRET, spaced)}`;
    const res = await verifyWebhookSignature(body, sigOverSpaced, APP_SECRET);
    expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(reserialized.length).toBeGreaterThan(0);
  });

  it('signs bytes and the same text alike: the RFC 4231 vector (T7)', async () => {
    const expected = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    const data = 'what do ya want for nothing?';
    expect(await hmacSha256Hex('Jefe', data)).toBe(expected);
    expect(await hmacSha256Hex('Jefe', new TextEncoder().encode(data))).toBe(expected);
  });

  it('verifies the raw bytes, Hebrew included', async () => {
    const hebrew = '{"text":"שלום"}';
    const bytes = new TextEncoder().encode(hebrew);
    expect(await verifyWebhookSignature(bytes, await sign(hebrew), APP_SECRET)).toEqual({ ok: true });
  });

  it('counts the cap in bytes, not characters', async () => {
    // Under the cap in characters, over it in UTF-8 bytes (two per Hebrew letter).
    const text = 'ש'.repeat(Math.ceil(MAX_WEBHOOK_BODY_BYTES / 2) + 1);
    expect(text.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    const bytes = new TextEncoder().encode(text);
    expect(await verifyWebhookSignature(bytes, await sign(text), APP_SECRET)).toEqual({ ok: false, reason: 'body_too_large' });
  });

  it('rejects a body over the size limit before doing any crypto', async () => {
    const big = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    const res = await verifyWebhookSignature(big, await sign(big), APP_SECRET);
    expect(res).toEqual({ ok: false, reason: 'body_too_large' });
  });

  it('rejects when the app secret is not configured', async () => {
    const res = await verifyWebhookSignature(body, await sign(body), '');
    expect(res).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('verifyWebhookHandshake (GET /wa/webhook)', () => {
  it('echoes the challenge when mode and token match', () => {
    const res = verifyWebhookHandshake(
      { mode: 'subscribe', token: VERIFY_TOKEN, challenge: '1158201444' },
      VERIFY_TOKEN,
    );
    expect(res).toEqual({ ok: true, challenge: '1158201444' });
  });

  it('rejects a wrong verify token', () => {
    const res = verifyWebhookHandshake(
      { mode: 'subscribe', token: 'nope', challenge: '1' },
      VERIFY_TOKEN,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a wrong mode', () => {
    const res = verifyWebhookHandshake(
      { mode: 'unsubscribe', token: VERIFY_TOKEN, challenge: '1' },
      VERIFY_TOKEN,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a missing challenge', () => {
    const res = verifyWebhookHandshake(
      { mode: 'subscribe', token: VERIFY_TOKEN, challenge: null },
      VERIFY_TOKEN,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects when the verify token is not configured', () => {
    const res = verifyWebhookHandshake(
      { mode: 'subscribe', token: '', challenge: '1' },
      '',
    );
    expect(res.ok).toBe(false);
  });
});
