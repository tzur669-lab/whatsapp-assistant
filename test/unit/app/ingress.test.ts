/**
 * The Worker's route check on the app channel (PLAN §6.18): which paths exist.
 * Here only the voice path's shape, which carries a location since 2026-10-01.
 */
import { describe, expect, it } from 'vitest';
import { checkAppRequest } from '../../../src/channels/app/ingress.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CONV = '11111111-1111-4111-8111-111111111111';

const status = async (path: string) => {
  const request = new Request(`https://assistant.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mp4' },
    body: new Uint8Array([1, 2, 3]),
  });
  const checked = await checkAppRequest(request, 'app');
  return checked.ok ? 200 : checked.status;
};

describe('the voice route', () => {
  it('takes a location after the id, or after the conversation', async () => {
    expect(await status(`/app/voice/${ID}`)).toBe(200);
    expect(await status(`/app/voice/${ID}/@32.09,34.78`)).toBe(200);
    expect(await status(`/app/voice/${ID}/${CONV}/@-33.9,151.21`)).toBe(200);
  });

  it("takes the town's name after the location, as hex", async () => {
    const name = Buffer.from('חיפה', 'utf8').toString('hex');
    expect(await status(`/app/voice/${ID}/@32.79,34.99,${name}`)).toBe(200);
    expect(await status(`/app/voice/${ID}/${CONV}/@32.79,34.99,${name}`)).toBe(200);
    expect(await status(`/app/voice/${ID}/@32.79,34.99,abc`)).toBe(404);
    expect(await status(`/app/voice/${ID}/@32.79,34.99,ZZ`)).toBe(404);
    expect(await status(`/app/voice/${ID}/@32.79,34.99,${'ab'.repeat(161)}`)).toBe(404);
  });

  it('refuses anything finer than two decimals, or out of place', async () => {
    expect(await status(`/app/voice/${ID}/@32.085,34.78`)).toBe(404);
    expect(await status(`/app/voice/${ID}/@32.09,34.78/${CONV}`)).toBe(404);
    expect(await status(`/app/voice/${ID}/@32.09`)).toBe(404);
    expect(await status(`/app/voice/${ID}/@x,y`)).toBe(404);
  });
});
