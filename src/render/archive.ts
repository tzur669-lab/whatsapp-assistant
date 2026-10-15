/**
 * Mail cleanup's words (block L, L5, 2026-10-15): the card, the outcomes and
 * `/unarchive`. Counts, the filter as the user's own words, and fixed text.
 * An unknown outcome is said to be unknown, never "done" or "failed".
 * Gender-neutral, ktiv maleh, dugri.
 */
import { isolate } from './bidi.js';
import type { Lang } from './format-time.js';
import type { ArchiveOutcome, RestoreOutcome } from '../core/mail-archive.js';

const count = (n: number, lang: Lang) => (lang === 'he' ? (n === 1 ? 'מייל אחד' : `${n} מיילים`) : n === 1 ? 'one email' : `${n} emails`);

export const archiveText = {
  /** The confirmation card: exactly what moves, the filter in words, and the visible side effect. */
  preview(n: number, filter: { sender: string | null; about: string | null; olderThanDays: number | null }, lang: Lang): string {
    const he = lang === 'he';
    const parts: string[] = [];
    if (filter.sender) parts.push(he ? `מ־${isolate(filter.sender)}` : `from ${isolate(filter.sender)}`);
    if (filter.about) parts.push(he ? `עם המילים ${isolate(filter.about)}` : `with the words ${isolate(filter.about)}`);
    if (filter.olderThanDays) parts.push(he ? `ישנים מ־${filter.olderThanDays} ימים` : `older than ${filter.olderThanDays} days`);
    return he
      ? `לארכב ${count(n, lang)} מתיבת הדואר הנכנס (${parts.join(', ')}).\nהמיילים לא נמחקים: הם עוברים ל"כל הדואר". תתווסף להם תווית זמנית תחת «בוט/», והיא תימחק אחרי שחזור או אחרי 7 ימים.`
      : `Archive ${count(n, lang)} from the inbox (${parts.join(', ')}).\nNothing is deleted: they move to All Mail. A temporary label under "בוט/" is added, removed after a restore or 7 days.`;
  },

  outcome(outcome: ArchiveOutcome, n: number, lang: Lang): string {
    const he = lang === 'he';
    switch (outcome) {
      case 'done':
        return he
          ? `ארכבתי ${count(n, lang)}. לביטול: ${isolate('/unarchive')} (עד 7 ימים).`
          : `Archived ${count(n, lang)}. To undo: /unarchive (within 7 days).`;
      case 'failed':
        return he ? 'הארכוב לא בוצע. המיילים נשארו בתיבה.' : 'Nothing was archived. The emails are still in the inbox.';
      case 'unknown':
        return he
          ? `לא ברור אם הארכוב הושלם. אפשר לבדוק ב־${isolate('Gmail')} או לשלוח ${isolate('/unarchive')}.`
          : 'It is not clear whether the archive finished. Check Gmail, or send /unarchive.';
    }
  },

  unknown(lang: Lang): string {
    return lang === 'he' ? 'לא ברור אם הארכוב הושלם.' : 'It is not clear whether the archive finished.';
  },

  restore(outcome: RestoreOutcome, lang: Lang): string {
    const he = lang === 'he';
    switch (outcome.kind) {
      case 'restored':
        return he
          ? `${outcome.count === 0 ? 'אין מה להחזיר: המיילים כבר בתיבה, באשפה או בספאם.' : `החזרתי ${count(outcome.count, lang)} לתיבת הדואר הנכנס.`} מיילים שארכבת בעצמך אחרי הארכוב חזרו גם הם.`
          : `${outcome.count === 0 ? 'Nothing to bring back: they are in the inbox, trash or spam.' : `Moved ${count(outcome.count, lang)} back to the inbox.`} Emails you archived again yourself came back too.`;
      case 'none':
        return he ? 'אין ארכוב לשחזר.' : 'There is no archive to undo.';
      case 'expired':
        return he ? `עברו 7 ימים. המיילים נמצאים ב"כל הדואר" ב־${isolate('Gmail')}.` : 'More than 7 days have passed. The emails are in All Mail in Gmail.';
      case 'running':
        return he ? 'הארכוב עדיין מתבצע. אפשר לנסות שוב בעוד כמה דקות.' : 'The archive is still running. Try again in a few minutes.';
      case 'already':
        return he ? 'הארכוב האחרון כבר שוחזר.' : 'The last archive was already undone.';
      case 'not_done':
        return he ? 'הארכוב האחרון לא בוצע, אין מה לשחזר.' : 'The last archive did not happen; there is nothing to undo.';
      case 'busy':
        return he ? 'שחזור כבר בתהליך.' : 'A restore is already running.';
      case 'label_deleted':
        return he
          ? `התווית נמחקה ב־${isolate('Gmail')}, אי אפשר לשחזר אוטומטית. המיילים נמצאים ב"כל הדואר".`
          : 'The label was deleted in Gmail, so this cannot be undone automatically. The emails are in All Mail.';
      case 'too_many':
        return he ? `יש יותר מיילים מהצפוי תחת התווית. אפשר לשחזר ידנית ב־${isolate('Gmail')}.` : 'More emails than expected carry the label. Restore them in Gmail.';
      case 'failed':
        return he ? 'השחזור נכשל, אפשר לנסות שוב.' : 'The restore failed. Try again.';
    }
  },

  /** The user renamed the bot's temporary label: it stays. */
  labelKept(lang: Lang): string {
    return lang === 'he'
      ? `התווית הזמנית ששיניתם את שמה ב־${isolate('Gmail')} נשארה. אפשר למחוק אותה ידנית.`
      : 'The temporary label you renamed in Gmail was kept. You can delete it yourself.';
  },
};
