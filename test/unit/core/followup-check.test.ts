/**
 * Did anyone answer a sent mail (block L, L2)? The classifier's matrix: a
 * person's reply, the user's own messages, drafts, machines, bounces, and
 * incomplete evidence — which is `unsure`, never "nobody replied".
 */
import { describe, expect, it } from 'vitest';
import { classifyThread } from '../../../src/core/followup-check.js';
import type { ThreadMessage } from '../../../src/google/gmail.js';

const SENT_AT = Date.UTC(2026, 9, 12, 9, 0);
const SENT = 'sent0001';

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm' + Math.random().toString(16).slice(2, 10),
    labelIds: ['INBOX'],
    internalDate: SENT_AT + 60 * 60 * 1000,
    fromLocal: 'dana',
    autoSubmitted: null,
    precedence: null,
    contentType: 'text/plain; charset=utf-8',
    listId: false,
    failedRecipients: false,
    ...overrides,
  };
}

const sent = message({ id: SENT, labelIds: ['SENT'], internalDate: SENT_AT, fromLocal: 'me' });
const classify = (...rest: ThreadMessage[]) => classifyThread([sent, ...rest], SENT, SENT_AT);

describe('classifyThread', () => {
  it('a person writing after the sent mail is an answer', () => {
    expect(classify(message())).toBe('answered');
  });

  it('a person writing with no headers at all is still an answer', () => {
    expect(classify(message({ contentType: null }))).toBe('answered');
  });

  it("the user's own later messages, an alias's and a self-forward keep waiting (all carry SENT)", () => {
    expect(classify(message({ labelIds: ['SENT'], fromLocal: 'me' }))).toBe('waiting');
    expect(classify(message({ labelIds: ['SENT'], fromLocal: 'me.work' }))).toBe('waiting');
    expect(classify(message({ labelIds: ['SENT', 'INBOX'], fromLocal: 'me' }))).toBe('waiting');
  });

  it('a draft in the thread is not an answer', () => {
    expect(classify(message({ labelIds: ['DRAFT'] }))).toBe('waiting');
  });

  it('messages from before the sent mail do not count', () => {
    expect(classify(message({ internalDate: SENT_AT - 1000 }))).toBe('waiting');
    expect(classify(message({ internalDate: SENT_AT }))).toBe('waiting');
  });

  it('machines are not answers: auto-replies, bulk, lists, list ids', () => {
    expect(classify(message({ autoSubmitted: 'auto-replied' }))).toBe('waiting');
    expect(classify(message({ precedence: 'bulk' }))).toBe('waiting');
    expect(classify(message({ precedence: 'list' }))).toBe('waiting');
    expect(classify(message({ precedence: 'auto_reply' }))).toBe('waiting');
    expect(classify(message({ listId: true }))).toBe('waiting');
  });

  it('Auto-Submitted: no is a person', () => {
    expect(classify(message({ autoSubmitted: 'no' }))).toBe('answered');
  });

  it('a delivery-status report or failed recipients is a bounce', () => {
    expect(classify(message({ contentType: 'multipart/report; report-type=delivery-status; boundary="x"', fromLocal: 'mailer-daemon' }))).toBe('bounced');
    expect(classify(message({ contentType: 'multipart/report; report-type="delivery-status"' }))).toBe('bounced');
    expect(classify(message({ failedRecipients: true }))).toBe('bounced');
  });

  it('a mail server writing without a failure report is only "maybe"', () => {
    expect(classify(message({ fromLocal: 'mailer-daemon' }))).toBe('maybe_bounced');
    expect(classify(message({ fromLocal: 'postmaster' }))).toBe('maybe_bounced');
  });

  it('a read receipt (a report of another type) is a machine, not a bounce', () => {
    expect(classify(message({ contentType: 'multipart/report; report-type=disposition-notification' }))).toBe('waiting');
  });

  it("a person's reply outranks a bounce: one recipient may fail and another answer", () => {
    expect(classify(message({ failedRecipients: true }), message())).toBe('answered');
  });

  it('missing metadata on any message is unsure, never "waiting"', () => {
    expect(classify(message({ labelIds: null }))).toBe('unsure');
    expect(classify(message({ internalDate: null }))).toBe('unsure');
  });

  it('the sent mail gone from the thread is unsure', () => {
    expect(classifyThread([message()], SENT, SENT_AT)).toBe('unsure');
    expect(classifyThread([], SENT, SENT_AT)).toBe('unsure');
  });

  it('only the sent mail: still waiting', () => {
    expect(classify()).toBe('waiting');
  });
});
