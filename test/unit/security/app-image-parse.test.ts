/**
 * An image from the app (PLAN §6.32): strict like every app body, capped in
 * bytes the app and the server share, base64 only, and a request that is the
 * user's own words — never a command.
 */
import { describe, expect, it } from 'vitest';
import {
  imageMatchesType,
  MAX_IMAGE_B64_CHARS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  parseImage,
} from '../../../src/channels/app/parse.js';
import { MAX_IMAGE_BODY_BYTES } from '../../../src/channels/app/ingress.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const WEBP = Buffer.from([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')]).toString('base64');

const base = { id: ID, text: 'תכניס ליומן', image: JPEG, mimeType: 'image/jpeg' };

describe('parseImage', () => {
  it('reads an image with its request', () => {
    expect(parseImage(bytes(base))).toEqual(base);
  });

  it('carries the conversation, its mode and the location', () => {
    const full = { ...base, conversationId: CONVERSATION, mode: 'smart', location: { latitude: 31.77, longitude: 35.21, name: 'ירושלים' } };
    expect(parseImage(bytes(full))).toEqual(full);
  });

  it('refuses an unknown field, a missing request, a command, an off type', () => {
    expect(parseImage(bytes({ ...base, from: '972500000000' }))).toBeNull();
    expect(parseImage(bytes({ ...base, text: '' }))).toBeNull();
    expect(parseImage(bytes({ ...base, text: '  /forget memory' }))).toBeNull();
    expect(parseImage(bytes({ ...base, text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))).toBeNull();
    expect(parseImage(bytes({ ...base, mimeType: 'image/gif' }))).toBeNull();
    expect(parseImage(bytes({ ...base, mimeType: 'text/html' }))).toBeNull();
  });

  it('accepts base64 only', () => {
    expect(parseImage(bytes({ ...base, image: '' }))).toBeNull();
    expect(parseImage(bytes({ ...base, image: `${JPEG.slice(0, -4)}"><` }))).toBeNull();
    expect(parseImage(bytes({ ...base, image: `${JPEG}\n` }))).toBeNull();
    expect(parseImage(bytes({ ...base, image: JPEG.slice(1) }))).toBeNull(); // not a multiple of 4
    expect(parseImage(bytes({ ...base, image: `=${JPEG.slice(1)}` }))).toBeNull(); // padding inside
    expect(parseImage(bytes({ ...base, image: 'data:image/jpeg;base64,AAAA' }))).toBeNull();
  });

  it('caps the image in bytes, the number the app uses too', () => {
    expect(MAX_IMAGE_BYTES).toBe(700_000);
    expect(MAX_IMAGE_B64_CHARS).toBe(4 * Math.ceil(MAX_IMAGE_BYTES / 3));
    expect(parseImage(bytes({ ...base, image: 'A'.repeat(MAX_IMAGE_B64_CHARS) }))).not.toBeNull();
    expect(parseImage(bytes({ ...base, image: 'A'.repeat(MAX_IMAGE_B64_CHARS + 4) }))).toBeNull();
  });

  it('fits a full image and a full request under the route cap', () => {
    const body = bytes({ ...base, text: 'א'.repeat(MAX_TEXT_CHARS), image: 'A'.repeat(MAX_IMAGE_B64_CHARS), conversationId: CONVERSATION, mode: 'local', location: { latitude: -31.77, longitude: -135.21, name: 'א'.repeat(40) } });
    expect(body.length).toBeLessThan(MAX_IMAGE_BODY_BYTES);
  });
});

describe('imageMatchesType', () => {
  it('checks the first bytes against the declared type', () => {
    expect(imageMatchesType('image/jpeg', JPEG)).toBe(true);
    expect(imageMatchesType('image/png', PNG)).toBe(true);
    expect(imageMatchesType('image/webp', WEBP)).toBe(true);
    expect(imageMatchesType('image/png', JPEG)).toBe(false);
    expect(imageMatchesType('image/jpeg', PNG)).toBe(false);
    expect(imageMatchesType('image/jpeg', Buffer.from('<svg onload=1>').toString('base64'))).toBe(false);
    expect(imageMatchesType('image/jpeg', 'AAAA')).toBe(false);
  });
});
