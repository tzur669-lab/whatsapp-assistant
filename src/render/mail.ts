/** Replies for Gmail (2026-10-01). Code templates; never an address. */
import { isolate } from './bidi.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { MailSummary } from '../google/gmail.js';

export const mailText = {
  results(mails: readonly MailSummary[], body: string | null, lang: Lang): string {
    const he = lang === 'he';
    if (mails.length === 0) return he ? 'לא נמצאו מיילים כאלה.' : 'No such mail found.';
    const lines = mails.map((mail) => {
      const when = formatWhen(localPartsOf(mail.at, ZONE), lang);
      const unread = mail.unread ? (he ? ' (לא נקרא)' : ' (unread)') : '';
      return `• ${when} — ${isolate(mail.fromName)}: ${isolate(mail.subject)}${unread}\n  ${isolate(mail.snippet)}`;
    });
    const out = [he ? 'מיילים:' : 'Mail:', ...lines];
    if (body !== null) out.push('', he ? 'תוכן המייל האחרון:' : 'The newest one says:', body || (he ? '(ריק)' : '(empty)'));
    return out.join('\n');
  },

  draftPreview(to: string | null, subject: string, body: string, lang: Lang): string {
    const he = lang === 'he';
    return [
      he ? 'טיוטה ב־Gmail (לא תישלח — השליחה מתוך Gmail):' : 'A Gmail draft (not sent — you send it from Gmail):',
      `${he ? 'אל' : 'To'}: ${to ? isolate(to) : he ? '(בלי נמען)' : '(no recipient)'}`,
      `${he ? 'נושא' : 'Subject'}: ${isolate(subject)}`,
      '',
      body,
    ].join('\n');
  },

  draftSaved(lang: Lang): string {
    return lang === 'he' ? 'הטיוטה נשמרה ב־Gmail. אפשר לשלוח אותה משם. ✉️' : 'The draft is saved in Gmail. Send it from there. ✉️';
  },

  unavailable(lang: Lang): string {
    return lang === 'he' ? 'Gmail לא זמין כרגע. כדאי לנסות שוב בעוד רגע.' : 'Gmail is unavailable right now. Try again in a moment.';
  },
};
