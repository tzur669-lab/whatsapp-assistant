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
import type { LearnFeature, LearnKind, LearnStatus, ProposalKind } from '../core/learn-store.js';

/** Two digits, as the app shows times. */
const hhmm = (minutes: number) =>
  isolateLtr(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
const hour = (h: number) => hhmm(h * 60);

/** One rate line's numbers: this week, and the mean of the weeks before it when there are 2 or more. */
export type RateLine = { now: number | null; before: number | null };

export type ReviewTrend = {
  /** Messages in the week that ended; null when that week is "no data". */
  messages: number | null;
  misses: RateLine;
  rephrases: RateLine;
  combined: RateLine;
};

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

  forgotten(counts: { events: number; weeks: number; proposals: number }): string {
    return [
      `מחקתי את יומן הלמידה: ${counts.events} פריטים, ${counts.weeks} שבועות של מונים ו-${counts.proposals} הצעות.`,
      `רשימת "לא הבנת" (${cmd('/misses')}) נשארת לפי הכללים שלה.`,
      'קבצים שכבר יוצאו לטלפון לא נמחקים.',
    ].join('\n');
  },

  /** `/learn export`: the file is made in the app, never sent in chat. */
  exportWhere: 'הייצוא נעשה באפליקציה: ☰ ← ייצוא למידה. הקובץ נשמר בתיקיית ההורדות.',

  /** The weekly review (K2): the trend, and once a month the export reminder. */
  review(trend: ReviewTrend, exportDue: boolean): string {
    const rate = (label: string, line: RateLine) => {
      if (line.now === null) return `${label}: אין מספיק נתונים`;
      const before = line.before === null ? '' : ` (ב-4 השבועות הקודמים: ${line.before})`;
      return `${label}: ${line.now} ל-100 הודעות${before}`;
    };
    return [
      'סיכום הלמידה של השבוע שעבר',
      ...(trend.messages === null
        ? ['אין מספיק נתונים לשבוע הזה.']
        : [
            `הודעות: ${trend.messages}`,
            rate('"לא הבנת"', trend.misses),
            rate('ניסוח חוזר', trend.rephrases),
            rate('יחד', trend.combined),
          ]),
      ...(exportDue ? ['הגיע הזמן לייצא: ☰ ← ייצוא למידה'] : []),
    ].join('\n');
  },

  /** A proposal, with its `ok` / `no` buttons. */
  proposal(kind: ProposalKind, value: number, context: { current: number; observed: number }): string {
    if (kind === 'digest_hour') {
      return `בדרך כלל ההודעה הראשונה שלך ביום מגיעה בסביבות ${hhmm(context.observed)}. להעביר את הסיכום היומי מ-${hour(context.current)} ל-${hour(value)}?`;
    }
    return `בתזכורות "מתי לצאת" ציינת בדרך כלל ${value} דקות נסיעה. לקבוע ${value} דקות כברירת מחדל, במקום ${context.current}?`;
  },

  proposalYes(kind: ProposalKind): string {
    return kind === 'digest_hour' ? 'כן, להעביר' : 'כן, לקבוע';
  },

  proposalNo: 'לא, תודה',

  /** The weekly question: one button per answer. */
  question(kind: ProposalKind): string {
    return kind === 'digest_hour'
      ? 'שאלה קצרה: באיזו שעה נוח לקבל את הסיכום היומי?'
      : 'שאלה קצרה: כמה זמן לוקחת בדרך כלל הנסיעה לפגישה?';
  },

  answerButton(kind: ProposalKind, value: number): string {
    return kind === 'digest_hour' ? `${String(value).padStart(2, '0')}:00` : `${value} דקות`;
  },

  applied(kind: ProposalKind, value: number): string {
    return kind === 'digest_hour'
      ? `עודכן. מעכשיו הסיכום היומי יישלח ב-${hour(value)}.`
      : `עודכן. כשלא נאמר זמן נסיעה, אחשב ${value} דקות.`;
  },

  declined: 'בסדר, לא שיניתי כלום.',

  answered: 'כבר נענה.',

  expired: 'פג התוקף של ההצעה.',

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

/** `/leave` (K2): the travel time "time to leave" uses when none is said. */
export const leaveText = {
  current(minutes: number, isDefault: boolean): string {
    return [
      `זמן הנסיעה בתזכורות "מתי לצאת", כשלא נאמר אחר: ${minutes} דקות${isDefault ? ' (ברירת המחדל)' : ''}.`,
      `לשינוי: ${cmd('/leave 20')}. לחזרה לברירת המחדל: ${cmd('/leave off')}.`,
    ].join('\n');
  },
  set(minutes: number): string {
    return `מעכשיו, כשלא נאמר זמן נסיעה, אחשב ${minutes} דקות.`;
  },
  reset(minutes: number): string {
    return `חזרתי לברירת המחדל: ${minutes} דקות.`;
  },
  invalid(min: number, max: number): string {
    return `אפשר לקבוע בין ${min} ל-${max} דקות. לדוגמה: ${cmd('/leave 20')}`;
  },
};
