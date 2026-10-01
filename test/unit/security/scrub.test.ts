/**
 * What the model may see, and what may leave as a link (plan invariants 2, 3).
 */
import { describe, expect, it } from 'vitest';
import { defangLinks, scrubForModel } from '../../../src/security/scrub.js';

describe('scrubForModel', () => {
  it('removes email addresses', () => {
    expect(scrubForModel('פגישה עם dana@example.com מחר')).toBe('פגישה עם [אימייל] מחר');
  });

  it('removes phone numbers in every common shape', () => {
    expect(scrubForModel('להתקשר ל-050-123-4567')).toBe('להתקשר ל-[מספר]');
    expect(scrubForModel('call +972 50 123 4567 now')).toBe('call [מספר] now');
    expect(scrubForModel('0501234567')).toBe('[מספר]');
  });

  it('removes a verification code next to the word for one', () => {
    expect(scrubForModel('קוד האימות שלך: 4829')).toBe('קוד האימות שלך: [קוד]');
    expect(scrubForModel('Your code is 482913')).toBe('Your code is [קוד]');
  });

  it('removes any long run of digits', () => {
    expect(scrubForModel('order 99812734')).toBe('order [מספר]');
  });

  it('removes links, with or without a scheme', () => {
    expect(scrubForModel('ראה https://evil.example/x?d=1 עכשיו')).toBe('ראה [קישור] עכשיו');
    expect(scrubForModel('www.site.co.il')).toBe('[קישור]');
    expect(scrubForModel('open evil.com please')).toBe('open [קישור] please');
  });

  it('keeps times, dates and years', () => {
    const text = 'יום ו׳ 2.10 · 10:00–11:00, 25.9.2026';
    expect(scrubForModel(text)).toBe(text);
  });
});

describe('defangLinks', () => {
  it('turns a link into text a phone will not linkify', () => {
    expect(defangLinks('לחצו https://evil.example/a?b=1')).toBe('לחצו evil[.]example/a?b=1');
    expect(defangLinks('www.evil.com')).toBe('www[.]evil[.]com');
    expect(defangLinks('see evil.com')).toBe('see evil[.]com');
  });

  it('leaves text without links alone', () => {
    const text = 'תזכורת: יום ו׳ 2.10 · 20:00 להתקשר לאבא.';
    expect(defangLinks(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = defangLinks('https://a.b.com/x');
    expect(defangLinks(once)).toBe(once);
  });
});
