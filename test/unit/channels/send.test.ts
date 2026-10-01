import { describe, expect, it } from 'vitest';
import { WhatsAppSender } from '../../../src/channels/whatsapp/send.js';
import { workersFetch } from '../../integration/workers-fetch.js';

describe('WhatsAppSender', () => {
  it('calls fetch the way the Workers runtime allows (no `this`)', async () => {
    const meta: typeof fetch = async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.fake' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const sender = new WhatsAppSender({
      phoneNumberId: '000000000000000',
      accessToken: 'fake-token',
      fetchImpl: workersFetch(meta),
    });

    expect(await sender.send({ to: '972500000000', text: 'hi' })).toEqual({ wamid: 'wamid.fake' });
  });
});
