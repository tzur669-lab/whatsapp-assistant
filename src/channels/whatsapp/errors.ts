/**
 * What a WhatsApp send failure actually means (PLAN §6.8).
 *
 * Every failure used to be recorded as `E_WA_SEND_<http status>` and retried
 * identically. That is wrong in both directions: 131026 will never succeed no
 * matter how often it is tried, and each retry spends one of a thousand free
 * messages to learn nothing; while 130429 will succeed shortly and should not
 * be given up on.
 *
 * Two routes reach here and both are handled the same way:
 *   - a non-2xx send response, whose body carries `error.code`
 *   - a `failed` delivery status webhook, whose `errors[0].code` is the same id
 *
 * **Only numbers are read from either.** `error.message` and `error_user_title`
 * echo the message that failed, so they are never parsed, never stored and
 * never logged (PLAN §7.3).
 */

export type Disposition =
  /** Try again later; the cause is transient. */
  | 'retry'
  /** The 24-hour window is shut. Not a WhatsApp problem to retry — reroute. */
  | 'window_closed'
  /** Stop sending for a while: the account is being rate-limited or flagged. */
  | 'back_off'
  /** It will never work. Report it and stop. */
  | 'give_up';

export type WaFailure = {
  /** Meta's numeric code, when one was given. */
  code: number | null;
  /** Stable, content-free, safe to log and to show in `/status`. */
  errorCode: string;
  disposition: Disposition;
};

/**
 * The codes worth telling apart. Anything absent is treated as retryable,
 * because an unknown failure is more likely to be a hiccup than a permanent
 * refusal — and the attempt counter caps how long that optimism can last.
 */
const CODES: ReadonlyMap<number, Disposition> = new Map([
  // Re-engagement: more than 24 hours since the user's last message. A reminder
  // routes to the calendar instead; retrying cannot help (PLAN §5, §6.7).
  [131047, 'window_closed'],
  [131051, 'window_closed'],

  // The recipient cannot receive it. Five retries spend five messages to learn
  // what the first one already said.
  [131026, 'give_up'],
  [131049, 'give_up'],

  // Throughput and pair rate limits: transient by definition.
  [130429, 'back_off'],
  [131056, 'retry'],
  [80007, 'back_off'],

  // Spam rate limit — the account is flagged. Sending more is the one thing
  // that makes this worse.
  [131048, 'back_off'],

  // Our own fault, and no retry fixes a bad request or a bad token.
  [100, 'give_up'],
  [190, 'give_up'],
  [10, 'give_up'],
  [200, 'give_up'],
  [131009, 'give_up'],
  [133010, 'give_up'],
]);

export function classifyMetaError(code: number | null, httpStatus: number | null): WaFailure {
  const known = code === null ? undefined : CODES.get(code);
  if (known) return { code, errorCode: `E_WA_${code}`, disposition: known };

  if (code !== null) return { code, errorCode: `E_WA_${code}`, disposition: 'retry' };

  // No code at all: fall back to the HTTP status, which at least separates
  // "we sent something wrong" from "Meta is having a moment".
  if (httpStatus === null) return { code: null, errorCode: 'E_WA_SEND_UNKNOWN', disposition: 'retry' };
  if (httpStatus === 401 || httpStatus === 403) {
    return { code: null, errorCode: `E_WA_SEND_${httpStatus}`, disposition: 'give_up' };
  }
  if (httpStatus === 429) {
    return { code: null, errorCode: 'E_WA_SEND_429', disposition: 'back_off' };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return { code: null, errorCode: `E_WA_SEND_${httpStatus}`, disposition: 'give_up' };
  }
  return { code: null, errorCode: `E_WA_SEND_${httpStatus}`, disposition: 'retry' };
}

/**
 * Pull the numeric code out of a Meta error body, and nothing else.
 *
 * Written defensively because it runs on a parsed response we do not control,
 * and narrowly because most of that body is the message that failed.
 */
export function metaErrorCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}
