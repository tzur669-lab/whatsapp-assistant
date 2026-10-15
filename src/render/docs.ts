/**
 * Documents' words (block L, L6, 2026-10-15): the confirmation card, which
 * names both destinations before anything happens, and the outcomes — each
 * destination said as it is (created, failed, unknown), never "uploaded" on a
 * guess. Gender-neutral, ktiv maleh, dugri.
 */
import { isolate, isolateLtr } from './bidi.js';
import { defangLinks } from '../security/scrub.js';
import type { Lang } from './format-time.js';

const firstLine = (body: string) => body.split('\n').find((line) => line.trim().length > 0)?.trim().slice(0, 80) ?? '';
const lastLine = (body: string) =>
  [...body.split('\n')].reverse().find((line) => line.trim().length > 0)?.trim().slice(0, 80) ?? '';

export const docsText = {
  defaultTitle(lang: Lang): string {
    return lang === 'he' ? 'מסמך' : 'Document';
  },

  preview(input: { title: string; body: string; toDrive: boolean; toPhone: boolean }, lang: Lang): string {
    const he = lang === 'he';
    const where = he
      ? input.toDrive && input.toPhone
        ? `יישמר בטלפון (הורדות) ויועלה ל־${isolate('Google Drive')} כמסמך.`
        : input.toDrive
          ? `יועלה ל־${isolate('Google Drive')} כמסמך (לא יישמר בטלפון).`
          : 'יישמר בטלפון בלבד (הורדות).'
      : input.toDrive && input.toPhone
        ? 'Saved on the phone (Downloads) and uploaded to Google Drive as a Doc.'
        : input.toDrive
          ? 'Uploaded to Google Drive as a Doc (not saved on the phone).'
          : 'Saved on the phone only (Downloads).';
    const first = firstLine(input.body);
    const last = lastLine(input.body);
    const lines = he
      ? [`📄 «${isolate(input.title)}», ${input.body.length} תווים.`, where, `שורה ראשונה: ${isolate(first)}`, ...(last !== first ? [`שורה אחרונה: ${isolate(last)}`] : [])]
      : [`📄 "${isolate(input.title)}", ${input.body.length} characters.`, where, `First line: ${isolate(first)}`, ...(last !== first ? [`Last line: ${isolate(last)}`] : [])];
    return lines.join('\n');
  },

  outcome(result: { drive: 'created' | 'failed' | 'unknown' | 'skipped'; link: string | null; phone: boolean }, lang: Lang): string {
    const he = lang === 'he';
    const lines: string[] = [];
    switch (result.drive) {
      case 'created':
        lines.push(he ? `נוצר ב־${isolate('Google Drive')}: ${isolateLtr(defangLinks(result.link ?? ''))}` : `Created in Google Drive: ${defangLinks(result.link ?? '')}`);
        break;
      case 'failed':
        lines.push(he ? `ההעלאה ל־${isolate('Google Drive')} נכשלה.` : 'The upload to Google Drive failed.');
        break;
      case 'unknown':
        lines.push(he ? `לא ברור אם המסמך נוצר ב־${isolate('Google Drive')}, אפשר לבדוק שם.` : 'It is not clear whether the Doc was created in Google Drive; check there.');
        break;
      case 'skipped':
        break;
    }
    if (result.phone) lines.push(he ? 'הקובץ לטלפון בכרטיס שלמטה: לחיצה שומרת אותו בהורדות.' : 'The phone copy is in the card below: a tap saves it to Downloads.');
    else if (result.drive !== 'created') lines.push(he ? 'לא נשמר עותק בטלפון.' : 'No copy was saved on the phone.');
    return lines.join('\n');
  },

  cardPreview(title: string, lang: Lang): string {
    return lang === 'he' ? `📄 שמירת «${isolate(title)}» בהורדות` : `📄 Save "${isolate(title)}" to Downloads`;
  },

  tainted(lang: Lang): string {
    return lang === 'he'
      ? 'מסמך נוצר רק מבקשה שכתבת או אמרת בעצמך, לא מטקסט ששותף או הועבר.'
      : 'A document is made only on your own request, not from shared or forwarded text.';
  },
};
