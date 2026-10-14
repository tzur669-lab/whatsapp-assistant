/**
 * `/learn`, in words (block K, K1, PLAN §6.31, 2026-10-14).
 *
 * The notice is cumulative: every kind up to the current version, the ones
 * the user has not been shown yet marked new. A test renders it and checks
 * that each `KIND_SINCE` entry appears.
 */
import { isolateLtr } from './bidi.js';
import { formatWhen } from './format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { KIND_SINCE, LEARN_NOTICE_VERSION } from '../core/learn-store.js';
import type { LearnFeature, LearnKind, LearnStatus } from '../core/learn-store.js';

const cmd = (text: string) => isolateLtr(text);

/** What each kind keeps. Closed: one line per `KIND_SINCE` entry. */
export const LEARN_FEATURE_LINES: Readonly<Record<LearnFeature, string>> = {
  miss: 'כשכותבים "לא הבנת": עותק של הבקשה ושל התשובה.',
  rephrase: 'בקשה שלא הבנתי, יחד עם הניסוח החדש שלה, אם נשלח תוך 3 דקות.',
  undo: 'לחיצה על "ביטול" אחרי פעולה: שם הפעולה וכמה זמן אחריה, בלי טקסט.',
  confirm_no: 'סירוב לאישור: שם הפעולה וכמה זמן אחרי השאלה, בלי טקסט.',
  leave: 'זמן הנסיעה בתזכורות "מתי לצאת", והאם נאמר במפורש.',
  weeks: 'מונים שבועיים: כמה הודעות, כמה "לא הבנת" וכמה ניסוחים חוזרים.',
  first_message: 'השעות של הודעות שנשלחות בזמן שהלמידה פועלת, כדי להציע שעה לסיכום היומי.',
};

const KIND_LABELS: Readonly<Record<LearnKind, string>> = {
  miss: '"לא הבנת"',
  rephrase: 'ניסוח חוזר',
  undo: 'ביטול',
  confirm_no: 'סירוב',
  leave: 'זמן יציאה',
};

export const learnText = {
  /** The notice. `seen`: the version the user already has; newer kinds are marked. */
  notice(seen: number | null, resent: boolean): string {
    const lines = (Object.keys(KIND_SINCE) as LearnFeature[])
      .filter((feature) => KIND_SINCE[feature] <= LEARN_NOTICE_VERSION)
      .map((feature) => {
        const fresh = seen !== null && KIND_SINCE[feature] > seen ? ' (חדש)' : '';
        return `• ${LEARN_FEATURE_LINES[feature]}${fresh}`;
      });
    return [
      resent ? 'שולח שוב את ההסבר על הלמידה.' : 'הלמידה הופעלה. כך אלמד להבין אותך טוב יותר.',
      'מה נשמר, מוצפן, בשרת:',
      ...lines,
      'מה לא נשמר: הודעות קוליות, טקסט ששותף או הועבר, פתקים ותוכן פרטי, תוכן מסך.',
      'המידע לא נשלח לשום מודל ולא משנה הרשאות. נאסף רק מרגע שההודעה הזאת הגיעה, ונשמר עד 60 יום (עד 200 פריטים).',
      `${cmd('/forget')} ו-${cmd('/forget memory')} לא מוחקים אותו.`,
      `${cmd('/learn off')} עוצר. ${cmd('/learn forget')} מוחק.`,
    ].join('\n');
  },

  alreadyOn: 'הלמידה כבר פועלת.',

  off: `הלמידה כבויה. מה שנשמר נשאר; ${cmd('/learn forget')} מוחק אותו.`,

  alreadyOff: 'הלמידה כבר כבויה.',

  unavailable: 'הלמידה לא זמינה כאן.',

  forgotten(counts: { events: number; weeks: number }): string {
    return [
      `מחקתי את יומן הלמידה: ${counts.events} פריטים ו-${counts.weeks} שבועות של מונים.`,
      `רשימת "לא הבנת" (${cmd('/misses')}) נשארת לפי הכללים שלה.`,
      'קבצים שכבר יוצאו לטלפון לא נמחקים.',
    ].join('\n');
  },

  status(status: LearnStatus): string {
    const state = !status.on
      ? `כבויה. ${cmd('/learn on')} מפעיל.`
      : status.seen === null || status.since === null
        ? 'מחכה שההסבר יגיע לטלפון. עד אז לא נאסף כלום.'
        : 'פועלת.';
    const counts = (Object.keys(KIND_LABELS) as LearnKind[])
      .map((kind) => `${KIND_LABELS[kind]} ${status.counts[kind]}`)
      .join(' · ');
    return [
      `הלמידה: ${state}`,
      `נשמרו: ${counts}`,
      ...(status.oldest !== null ? [`הפריט הישן ביותר: ${formatWhen(localPartsOf(status.oldest, ZONE), 'he')}`] : []),
    ].join('\n');
  },
};
