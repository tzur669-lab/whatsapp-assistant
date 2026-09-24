/**
 * Telling WhatsApp failures apart (PLAN §6.8, §11.3).
 *
 * Every failure used to be `E_WA_SEND_<http status>` and every one was retried
 * the same way. These cases pin the four things a failure can now mean, and the
 * rule that decides them: retrying 131026 five times spends five of a thousand
 * free messages to learn what the first attempt already said.
 */
import { describe, expect, it } from 'vitest';
import { classifyMetaError, metaErrorCode } from '../../../src/channels/whatsapp/errors.js';
import { SendError } from '../../../src/channels/whatsapp/send.js';

describe('classifyMetaError', () => {
  it('routes a shut window away from WhatsApp instead of retrying it', () => {
    // 131047 means more than 24 hours since the user wrote. No number of
    // retries opens that window; only the user does.
    expect(classifyMetaError(131047, 400).disposition).toBe('window_closed');
  });

  it('gives up on an undeliverable recipient', () => {
    expect(classifyMetaError(131026, 400).disposition).toBe('give_up');
  });

  it('backs off on a rate limit rather than pushing harder', () => {
    expect(classifyMetaError(130429, 429).disposition).toBe('back_off');
    // A spam flag is the one case where sending more is what makes it worse.
    expect(classifyMetaError(131048, 400).disposition).toBe('back_off');
  });

  it('gives up on a bad token, because no retry mints a new one', () => {
    expect(classifyMetaError(190, 401).disposition).toBe('give_up');
    expect(classifyMetaError(null, 401).disposition).toBe('give_up');
  });

  it('retries a server error', () => {
    expect(classifyMetaError(null, 500).disposition).toBe('retry');
    expect(classifyMetaError(null, 503).disposition).toBe('retry');
  });

  it('treats an unknown code as a hiccup, which the attempt cap bounds', () => {
    // Optimism is safe here only because attempts are counted: an unknown
    // failure gets five tries, not unlimited ones.
    expect(classifyMetaError(999999, 400).disposition).toBe('retry');
  });

  it('gives a stable, content-free code for every case', () => {
    expect(classifyMetaError(131047, 400).errorCode).toBe('E_WA_131047');
    expect(classifyMetaError(null, 500).errorCode).toBe('E_WA_SEND_500');
    expect(classifyMetaError(null, null).errorCode).toBe('E_WA_SEND_UNKNOWN');
  });
});

describe('metaErrorCode', () => {
  it('takes the number and nothing else', () => {
    // The rest of that object echoes the message that failed, so it is never
    // read (§7.3). This test exists to keep that true.
    const body = {
      error: {
        code: 131047,
        message: 'Re-engagement message: להתקשר לאבא',
        error_data: { details: 'להתקשר לאבא' },
      },
    };
    expect(metaErrorCode(body)).toBe(131047);
  });

  it('answers null for anything that is not a Meta error body', () => {
    expect(metaErrorCode(null)).toBeNull();
    expect(metaErrorCode({})).toBeNull();
    expect(metaErrorCode({ error: 'nope' })).toBeNull();
    expect(metaErrorCode({ error: { code: 'not a number' } })).toBeNull();
    expect(metaErrorCode('a string')).toBeNull();
  });
});

describe('SendError', () => {
  it('carries the classification, so the caller need not re-derive it', () => {
    const error = new SendError(400, 'send_failed', 131026);
    expect(error.failure.disposition).toBe('give_up');
    expect(error.message).toBe('E_WA_131026');
  });

  it('still works when Meta gave no code at all', () => {
    const error = new SendError(500);
    expect(error.failure.disposition).toBe('retry');
    expect(error.message).toBe('E_WA_SEND_500');
  });
});
