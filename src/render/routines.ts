/**
 * What the assistant says about routines (PLAN §6.27). Code-rendered: the
 * routine's name is the user's own label, the app's label is the phone's, and
 * both are isolated so a Latin name cannot reorder the Hebrew around it.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import { localPartsOf } from '../time/tz.js';
import { ROUTINE_MAX_LATE_MS } from '../tools/routine-store.js';

export type RoutineView = {
  name: string;
  appLabel: string;
  dueAtUtc: number;
  tz: string;
  now: boolean;
  /** Its place in the phone's list, when known (2026-10-12). */
  number?: number;
};

/** Why a run stopped, as the phone reports it. Closed: anything else is `error`. */
export const RUN_REASONS = [
  'locked',
  'app_missing',
  'app_not_front',
  'launch_confirm',
  'app_left',
  'text_not_found',
  'not_verified',
  'target_not_found',
  'target_disabled',
  'target_ambiguous',
  'tap_refused',
  'deadline',
  'changed',
  'service_off',
  'error',
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

function when(view: Pick<RoutineView, 'dueAtUtc' | 'tz'>, lang: Lang): string {
  return formatWhen(localPartsOf(view.dueAtUtc, view.tz), lang);
}

function named(view: Pick<RoutineView, 'name' | 'number'>): string {
  return view.number === undefined ? isolate(view.name) : `${isolateLtr(String(view.number))} · ${isolate(view.name)}`;
}

const MAX_LATE_MINUTES = Math.round(ROUTINE_MAX_LATE_MS / 60_000);

export const routineText = {
  /** The confirmation's question. */
  preview(view: RoutineView, lang: Lang): string {
    if (lang !== 'he') {
      return view.now
        ? `Run the routine ${named(view)} in ${isolate(view.appLabel)} now?`
        : `Run the routine ${named(view)} in ${isolate(view.appLabel)} on ${when(view, lang)}? Its details and a cancel button will be in the reminders conversation.`;
    }
    return view.now
      ? `להפעיל עכשיו את השגרה ${named(view)} באפליקציה ${isolate(view.appLabel)}?`
      : `להפעיל את השגרה ${named(view)} באפליקציה ${isolate(view.appLabel)} ב${when(view, lang)}? הפרטים וכפתור ביטול יופיעו בשיחת התזכורות.`;
  },

  scheduled(view: RoutineView, lang: Lang): string {
    if (lang !== 'he') {
      return view.now
        ? `Running ${named(view)} now. The result will come here.`
        : `Set: ${named(view)} runs on ${when(view, lang)}. Its details and a cancel button are in the reminders conversation; the result will come there too.`;
    }
    return view.now
      ? `מפעיל עכשיו את ${named(view)}. התוצאה תגיע לשיחת התזכורות.`
      : `נקבע: ${named(view)} תופעל ב${when(view, lang)}. הפרטים וכפתור ביטול נמצאים בשיחת התזכורות, וגם התוצאה תגיע לשם.`;
  },

  /** The card in the reminders conversation, with a cancel button (2026-10-12). */
  card(view: RoutineView, lang: Lang): string {
    return lang === 'he'
      ? `⚙️ שגרה מתוזמנת: ${named(view)} באפליקציה ${isolate(view.appLabel)}, ב${when(view, lang)}.\nשתי דקות לפני תגיע תזכורת, ובסוף הודעה אם הפעולה בוצעה. כדי לבטל, יש ללחוץ על ביטול.`
      : `⚙️ Scheduled routine: ${named(view)} in ${isolate(view.appLabel)}, on ${when(view, lang)}.\nA notice comes two minutes before, and a message at the end saying whether it worked. Tap cancel to stop it.`;
  },

  /** Two minutes before. */
  notice(view: RoutineView, lang: Lang): string {
    return lang === 'he'
      ? `בעוד שתי דקות אפעיל את ${named(view)} באפליקציה ${isolate(view.appLabel)}. כדי לעצור, יש ללחוץ על ביטול.`
      : `In two minutes I'll run ${named(view)} in ${isolate(view.appLabel)}. Tap cancel to stop it.`;
  },

  cancelButton(lang: Lang): string {
    return lang === 'he' ? 'ביטול' : 'Cancel';
  },

  cancelled(view: Pick<RoutineView, 'name'>, lang: Lang): string {
    return lang === 'he' ? `בוטל. ${named(view)} לא תופעל.` : `Cancelled. ${named(view)} will not run.`;
  },

  tooLateToCancel(lang: Lang): string {
    return lang === 'he'
      ? 'כבר מאוחר מדי לבטל: השגרה כבר התחילה לרוץ בטלפון. התוצאה תגיע לכאן.'
      : 'Too late to cancel: the routine has already started on the phone. The result will come here.';
  },

  nothingToCancel(lang: Lang): string {
    return lang === 'he'
      ? 'אין מה לבטל: השגרה כבר רצה, בוטלה או שעבר הזמן שלה.'
      : 'Nothing to cancel: the routine already ran, was cancelled, or its time passed.';
  },

  done(view: RoutineView, lang: Lang): string {
    return lang === 'he'
      ? `✓ בוצע: ${named(view)} הופעלה, והאפליקציה אישרה. ${when(view, lang)}`
      : `✓ ${named(view)} ran, and the app confirmed it. ${when(view, lang)}`;
  },

  unverified(view: RoutineView, lang: Lang): string {
    return lang === 'he'
      ? `${named(view)}: כל השלבים בוצעו, אבל בשגרה אין שלב אימות, ולכן לא ידוע אם הפעולה נקלטה. כדאי לבדוק באפליקציה.`
      : `${named(view)}: every step ran, but the routine has no check step, so it is not known whether it registered. Check the app.`;
  },

  failed(view: RoutineView, reason: RunReason, lang: Lang): string {
    return lang === 'he'
      ? `${named(view)} לא הופעלה, ושום דבר לא השתנה באפליקציה. הסיבה: ${reasonText(reason, lang)}.`
      : `${named(view)} did not run, and nothing changed in the app. Reason: ${reasonText(reason, lang)}.`;
  },

  /** Stopped after a tap or typing, or the phone never reported. */
  unknown(view: RoutineView, reason: RunReason | null, lang: Lang): string {
    const why =
      reason === null
        ? lang === 'he'
          ? 'הטלפון לא דיווח על התוצאה'
          : 'the phone did not report back'
        : lang === 'he'
          ? `השגרה נעצרה אחרי לחיצה או הקלדה (${reasonText(reason, lang)})`
          : `it stopped after a tap or typing (${reasonText(reason, lang)})`;
    return lang === 'he'
      ? `לא ידוע אם ${named(view)} הופעלה: ${why}. כדאי לבדוק באפליקציה.`
      : `Not known whether ${named(view)} ran: ${why}. Check the app.`;
  },

  expired(view: RoutineView, lang: Lang): string {
    return lang === 'he'
      ? `${named(view)} לא הופעלה: עברו יותר מ־${isolateLtr(String(MAX_LATE_MINUTES))} דקות מהזמן שנקבע, ${when(view, lang)}, והטלפון לא התחיל אותה. שגרה לא רצה באיחור.`
      : `${named(view)} did not run: more than ${MAX_LATE_MINUTES} minutes passed since ${when(view, lang)} and the phone had not started it. A routine never runs late.`;
  },

  changed(view: Pick<RoutineView, 'name'>, lang: Lang): string {
    return lang === 'he'
      ? `${named(view)} לא תופעל: השגרה נמחקה או השתנתה בטלפון אחרי האישור. אפשר לבקש שוב.`
      : `${named(view)} will not run: the routine was deleted or changed on the phone after the confirmation. Ask again.`;
  },
};

export function reasonText(reason: RunReason, lang: Lang): string {
  const he = lang === 'he';
  switch (reason) {
    case 'locked':
      return he ? 'הטלפון היה נעול' : 'the phone was locked';
    case 'app_missing':
      return he ? 'האפליקציה לא מותקנת' : 'the app is not installed';
    case 'app_not_front':
      return he ? 'האפליקציה לא נפתחה בזמן' : 'the app did not open in time';
    case 'launch_confirm':
      return he
        ? 'הטלפון שאל אם לאפשר לעוזר לפתוח את האפליקציה, ואף אחד לא אישר'
        : 'the phone asked whether the assistant may open the app, and nobody answered';
    case 'app_left':
      return he ? 'האפליקציה ירדה מהמסך באמצע' : 'the app left the screen half-way';
    case 'text_not_found':
      return he ? 'הטקסט שהשגרה חיכתה לו לא הופיע' : 'the text it waited for did not appear';
    case 'not_verified':
      return he ? 'האישור שהפעולה הצליחה לא הופיע' : 'the sign that it worked did not appear';
    case 'target_not_found':
      return he ? 'לא נמצא במסך על מה ללחוץ או איפה להקליד' : 'what to tap or type into was not on the screen';
    case 'target_disabled':
      return he ? 'הכפתור היה כבוי, למשל כי הפעולה כבר בוצעה' : 'the button was off, for example because it was already done';
    case 'target_ambiguous':
      return he ? 'נמצא יותר ממקום אחד מתאים ללחיצה או להקלדה' : 'more than one place matched';
    case 'tap_refused':
      return he ? 'הלחיצה או ההקלדה לא התקבלו' : 'the tap or the typing was not accepted';
    case 'deadline':
      return he ? 'השגרה לקחה יותר מ־4 דקות' : 'it took more than 4 minutes';
    case 'changed':
      return he ? 'השגרה השתנתה בטלפון אחרי האישור' : 'the routine changed on the phone after the confirmation';
    case 'service_off':
      return he
        ? 'שירות הנגישות של השגרות כבוי בטלפון. אפשר להפעיל אותו במסך השגרות'
        : "the routines' accessibility service is off on the phone. Turn it on from the routines screen";
    case 'error':
      return he ? 'תקלה בטלפון' : 'an error on the phone';
  }
}
