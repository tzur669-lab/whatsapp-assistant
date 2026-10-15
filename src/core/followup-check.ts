/**
 * Did anyone answer a sent mail? (block L, L2, 2026-10-15). Pure: the thread's
 * metadata in, a verdict out; no I/O, no Cloudflare (invariant 11).
 *
 * What it means is "someone replied in the thread", never "the intended
 * recipient answered": telling those apart would mean keeping email
 * addresses (invariant 2). When the evidence is incomplete the verdict is
 * `unsure`, and the user is told the check could not be made — never that
 * nobody answered.
 */
import type { ThreadMessage } from '../google/gmail.js';

export type FollowUpVerdict =
  /** A person's message after the sent one. Settled silently. */
  | 'answered'
  /** A delivery-status report or a failed-recipients header: the mail did not arrive. */
  | 'bounced'
  /** A mail server wrote, without saying the mail failed: "it may not have arrived". */
  | 'maybe_bounced'
  /** Nothing yet but the user's own messages, drafts and machines. */
  | 'waiting'
  /** The thread cannot be read with confidence: the sent mail is gone or a message lacks its metadata. */
  | 'unsure';

const AUTOMATIC_PRECEDENCE = new Set(['auto_reply', 'bulk', 'list', 'junk']);
const MAIL_SERVERS = new Set(['mailer-daemon', 'postmaster']);

/** A delivery-status report (RFC 3464), not a read receipt or a feedback report. */
function isDeliveryReport(contentType: string | null): boolean {
  if (!contentType || !contentType.startsWith('multipart/report')) return false;
  return /report-type\s*=\s*"?delivery-status"?/.test(contentType);
}

/** A machine wrote it: an auto-reply, a list, a bulk sender, or any report. */
function isAutomatic(message: ThreadMessage): boolean {
  if (message.autoSubmitted !== null && message.autoSubmitted !== 'no') return true;
  if (message.precedence !== null && AUTOMATIC_PRECEDENCE.has(message.precedence)) return true;
  if (message.listId) return true;
  return message.contentType !== null && message.contentType.startsWith('multipart/report');
}

export function classifyThread(messages: readonly ThreadMessage[], sentId: string, sentAt: number): FollowUpVerdict {
  // The sent mail itself must still be here, or nothing after it can be placed.
  if (!messages.some((message) => message.id === sentId)) return 'unsure';
  // A person's reply outranks a bounce: with several recipients, one may fail
  // and another answer.
  let bounced = false;
  let maybeBounced = false;
  let answered = false;
  for (const message of messages) {
    if (message.id === sentId) continue;
    // Missing metadata: no message can be dismissed as "before" or "mine".
    if (message.labelIds === null || message.internalDate === null) return 'unsure';
    if (message.internalDate <= sentAt) continue;
    // The user's own later messages (every alias carries SENT), and drafts.
    if (message.labelIds.includes('SENT') || message.labelIds.includes('DRAFT')) continue;
    if (message.failedRecipients || isDeliveryReport(message.contentType)) bounced = true;
    else if (message.fromLocal !== null && MAIL_SERVERS.has(message.fromLocal)) maybeBounced = true;
    // Headers absent is normal for a person's mail.
    else if (!isAutomatic(message)) answered = true;
  }
  if (answered) return 'answered';
  if (bounced) return 'bounced';
  return maybeBounced ? 'maybe_bounced' : 'waiting';
}
