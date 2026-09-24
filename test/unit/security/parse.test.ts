import { describe, expect, it } from 'vitest';
import { parseWebhookPayload } from '../../../src/channels/whatsapp/parse.js';

const FROM = '972500000000';

function textPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
              messages: [
                {
                  from: FROM,
                  id: 'wamid.AAA',
                  timestamp: '1758700000',
                  type: 'text',
                  text: { body: 'תזכיר לי מחר ב-8' },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhookPayload', () => {
  it('extracts a text message', () => {
    const events = parseWebhookPayload(textPayload());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'text',
      wamid: 'wamid.AAA',
      from: FROM,
      text: 'תזכיר לי מחר ב-8',
      sentAtMs: 1758700000 * 1000,
      forwarded: false,
    });
  });

  it('flags forwarded messages', () => {
    const events = parseWebhookPayload(textPayload({ context: { forwarded: true } }));
    expect(events[0]).toMatchObject({ forwarded: true });
  });

  it('flags frequently forwarded messages', () => {
    const events = parseWebhookPayload(
      textPayload({ context: { frequently_forwarded: true } }),
    );
    expect(events[0]).toMatchObject({ forwarded: true });
  });

  it('extracts an interactive button reply', () => {
    const events = parseWebhookPayload(
      textPayload({
        type: 'interactive',
        text: undefined,
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'pa:abc:nonce:ok', title: 'אישור' },
        },
      }),
    );
    expect(events[0]).toMatchObject({ kind: 'button', buttonId: 'pa:abc:nonce:ok' });
  });

  it('maps unsupported message types to an explicit kind', () => {
    const events = parseWebhookPayload(
      textPayload({ type: 'image', text: undefined, image: { id: 'x' } }),
    );
    expect(events[0]).toMatchObject({ kind: 'unsupported', messageType: 'image' });
  });

  it('extracts delivery statuses', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '0',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID' },
                statuses: [
                  { id: 'wamid.OUT', status: 'delivered', timestamp: '1758700100', recipient_id: FROM },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = parseWebhookPayload(payload);
    expect(events[0]).toMatchObject({ kind: 'status', wamid: 'wamid.OUT', status: 'delivered' });
  });

  it('returns nothing for a non-messages field', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '0', changes: [{ field: 'account_update', value: {} }] }],
    };
    expect(parseWebhookPayload(payload)).toEqual([]);
  });

  it('returns nothing for malformed payloads instead of throwing', () => {
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload({})).toEqual([]);
    expect(parseWebhookPayload({ entry: 'nope' })).toEqual([]);
    expect(parseWebhookPayload({ object: 'x', entry: [{ changes: [{ field: 'messages', value: { messages: [{}] } }] }] })).toEqual([]);
  });

  it('caps text length so an oversized body cannot flow onward', () => {
    const events = parseWebhookPayload(textPayload({ text: { body: 'א'.repeat(5000) } }));
    expect(events[0]).toMatchObject({ kind: 'text' });
    const e = events[0]!;
    if (e.kind === 'text') expect(e.text.length).toBeLessThanOrEqual(4096);
  });
});
