/**
 * The app channel's request bodies (PLAN §6.18). Strict: an unknown field, a
 * wrong type or an over-long value is a 400, never a partial read.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAck,
  parseMessage,
  parsePair,
  parsePushToken,
  parseReport,
  MESSAGE_ID,
} from '../../../src/channels/app/parse.js';

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('parseMessage', () => {
  it('reads a text message', () => {
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: 'תזכיר לי מחר' }))).toEqual({
      id: ID,
      kind: 'text',
      text: 'תזכיר לי מחר',
    });
  });

  it('reads a button tap', () => {
    const buttonId = 'snooze:0a1b:2c3d:m10';
    expect(parseMessage(bytes({ id: ID, kind: 'button', buttonId }))).toEqual({ id: ID, kind: 'button', buttonId });
  });

  it('carries the conversation a message was written in, when the app sends one', () => {
    const conversationId = '22222222-2222-4222-8222-222222222222';
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: 'x', conversationId }))).toEqual({
      id: ID,
      kind: 'text',
      text: 'x',
      conversationId,
    });
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: 'x', conversationId: 'nope' }))).toBeNull();
  });

  it('lower-cases the id, so a retry cannot dodge dedupe by case', () => {
    expect(parseMessage(bytes({ id: ID.toUpperCase(), kind: 'text', text: 'x' }))?.id).toBe(ID);
  });

  it('refuses unknown fields, a missing text, over-long text and a non-uuid id', () => {
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: 'x', from: '972500000000' }))).toBeNull();
    expect(parseMessage(bytes({ id: ID, kind: 'text' }))).toBeNull();
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: 'x'.repeat(2001) }))).toBeNull();
    expect(parseMessage(bytes({ id: 'not-a-uuid', kind: 'text', text: 'x' }))).toBeNull();
    expect(parseMessage(bytes({ id: ID, kind: 'text', text: '' }))).toBeNull();
  });

  it('refuses a button id with anything but the button alphabet', () => {
    expect(parseMessage(bytes({ id: ID, kind: 'button', buttonId: 'snooze:<script>' }))).toBeNull();
    expect(parseMessage(bytes({ id: ID, kind: 'button', buttonId: 'a'.repeat(257) }))).toBeNull();
  });

  it('refuses what is not JSON, or not UTF-8', () => {
    expect(parseMessage(bytes('not json'))).toBeNull();
    expect(parseMessage(new Uint8Array([0xff, 0xfe, 0x7b]))).toBeNull();
  });
});

describe('parseAck', () => {
  it('reads a list of positive integers', () => {
    expect(parseAck(bytes({ seqs: [1, 2, 99] }))).toEqual({ seqs: [1, 2, 99] });
  });

  it('refuses an empty list, too many, and anything but integers', () => {
    expect(parseAck(bytes({ seqs: [] }))).toBeNull();
    expect(parseAck(bytes({ seqs: Array.from({ length: 201 }, (_, i) => i + 1) }))).toBeNull();
    expect(parseAck(bytes({ seqs: [1.5] }))).toBeNull();
    expect(parseAck(bytes({ seqs: [0] }))).toBeNull();
    expect(parseAck(bytes({ seqs: ['1'] }))).toBeNull();
  });
});

describe('parsePair', () => {
  const good = {
    publicKey: Buffer.alloc(91, 1).toString('base64'),
    pushToken: 'fake-push-token',
    timestamp: 1_790_000_000_000,
    mac: 'a'.repeat(64),
  };

  it('reads a pairing request — which never carries the code itself', () => {
    expect(parsePair(bytes(good))).toEqual(good);
    expect(parsePair(bytes({ ...good, code: 'ABCD' }))).toBeNull();
  });

  it('refuses a malformed MAC or key', () => {
    expect(parsePair(bytes({ ...good, mac: 'A'.repeat(64) }))).toBeNull();
    expect(parsePair(bytes({ ...good, publicKey: 'x'.repeat(300) }))).toBeNull();
  });
});

describe('parsePushToken and parseReport', () => {
  it('read their own shapes only', () => {
    expect(parsePushToken(bytes({ pushToken: 't' }))).toEqual({ pushToken: 't' });
    expect(parsePushToken(bytes({ pushToken: '' }))).toBeNull();

    const report = { dispatchId: 'a'.repeat(32), matched: 'one', outcome: 'placed' };
    expect(parseReport(bytes(report))).toEqual(report);
    expect(parseReport(bytes({ ...report, number: '0500000000' }))).toBeNull();
  });
});

describe('MESSAGE_ID', () => {
  it('matches a lowercase uuid only', () => {
    expect(MESSAGE_ID.test(ID)).toBe(true);
    expect(MESSAGE_ID.test(ID.toUpperCase())).toBe(false);
  });
});
