/**
 * What the assistant says about a routine draft (docs/plans/routine-builder.md,
 * part 1). Code-rendered: the model's note is not here, and no screen text is.
 * The app's label and the user's own words are isolated so Latin text cannot
 * reorder the Hebrew.
 */
import { isolate, isolateLtr } from './bidi.js';
import type { Lang } from './format-time.js';
import type { DraftStatus } from '../tools/routine-draft-store.js';

export type DraftCardView = { appLabel: string; goal: string; inputs: readonly string[]; words: readonly string[] };

function numbered(values: readonly string[]): string {
  return values.map((value, i) => `${isolateLtr(String(i + 1))}. «${isolate(value)}»`).join('\n');
}

/** Why a draft failed, as the user reads it. Codes not listed read as a general failure. */
const FAILED_HE: Readonly<Record<string, string>> = {
  locked: 'הטלפון נעול',
  app_not_front: 'האפליקציה לא נפתחה',
  launch_confirm: 'הטלפון ביקש אישור לפתוח את האפליקציה',
  model_error: 'המודל לא החזיר טיוטה שאפשר להשתמש בה',
  quota: 'מכסת המודל להיום נגמרה',
  busy: 'המודלים עסוקים כרגע',
  sealed_missing: 'פרטי הבקשה לא נמצאו',
  not_allowed: 'האפליקציה לא ברשימה של סוכן המסך',
  unsafe_step: 'הטיוטה כללה לחיצה שנראית כמו שליחה, תשלום או מחיקה, או כפתור כללי',
  model_sensitive: 'הבקשה כוללת לחיצה שנראית כמו שליחה, תשלום או מחיקה, ושגרה לא עושה כזו לבד',
  model_unclear: 'לא ברור מה השגרה צריכה לעשות',
  model_not_found: 'לא מצאתי במסך הראשון את מה שצריך',
};

const FAILED_EN: Readonly<Record<string, string>> = {
  locked: 'the phone is locked',
  app_not_front: 'the app did not open',
  launch_confirm: 'the phone asked to allow opening the app',
  model_error: 'the model returned no usable draft',
  quota: "the model's quota for today is used up",
  busy: 'the models are busy right now',
  sealed_missing: 'the request details were not found',
  not_allowed: "the app is not on the screen agent's list",
  unsafe_step: 'the draft held a tap that looks like sending, paying or deleting, or a generic button',
  model_sensitive: 'the request holds a tap that looks like sending, paying or deleting, which a routine never does by itself',
  model_unclear: 'it is not clear what the routine should do',
  model_not_found: 'I did not find what is needed on the first screen',
};

export type DraftEndStatus = Extract<DraftStatus, 'offered' | 'build_failed' | 'slot_busy' | 'expired' | 'unknown' | 'preempted'>;

export const draftText = {
  /** The confirmation's question: the app, the goal, and every text the draft may use, word for word. */
  preview(view: DraftCardView, lang: Lang): string {
    if (lang !== 'he') {
      return [
        `Build a routine draft in ${isolate(view.appLabel)}?`,
        `Goal: «${isolate(view.goal)}»`,
        view.words.length > 0 ? `Words from your message:\n${numbered(view.words)}` : null,
        view.inputs.length > 0 ? `Text to type:\n${numbered(view.inputs)}` : null,
        'The app opens only to read its first screen. Nothing is tapped and nothing is saved until you save the routine on the phone.',
      ]
        .filter((line) => line !== null)
        .join('\n');
    }
    return [
      `לבנות טיוטת שגרה באפליקציה ${isolate(view.appLabel)}?`,
      `המטרה: «${isolate(view.goal)}»`,
      view.words.length > 0 ? `מילים מההודעה:\n${numbered(view.words)}` : null,
      view.inputs.length > 0 ? `טקסט להקלדה:\n${numbered(view.inputs)}` : null,
      'האפליקציה תיפתח רק כדי לקרוא את המסך הראשון. שום דבר לא יילחץ ושום דבר לא יישמר, עד ששומרים את השגרה בטלפון.',
    ]
      .filter((line) => line !== null)
      .join('\n');
  },

  started(appLabel: string, lang: Lang): string {
    return lang === 'he'
      ? `האפליקציה ${isolate(appLabel)} נפתחת לקריאת המסך הראשון. הטיוטה תופיע בטלפון לבדיקה ולשמירה.`
      : `${isolate(appLabel)} is opening so its first screen can be read. The draft will appear on the phone to review and save.`;
  },

  /** A draft that failed before it reached the phone's review screen. */
  failed(reason: string, appLabel: string, lang: Lang): string {
    const app = isolate(appLabel);
    if (lang !== 'he') {
      return `I could not build a routine draft in ${app}: ${FAILED_EN[reason] ?? 'something went wrong'}. You can ask again.`;
    }
    return `לא הצלחתי לבנות טיוטת שגרה באפליקציה ${app}: ${FAILED_HE[reason] ?? 'משהו השתבש'}. אפשר לבקש שוב.`;
  },

  /** The one line for every other end. */
  ended(status: DraftEndStatus, appLabel: string, lang: Lang): string {
    const app = isolate(appLabel);
    const he = lang === 'he';
    switch (status) {
      case 'offered':
        return he
          ? `טיוטת השגרה לאפליקציה ${app} מוכנה בטלפון. יש לבדוק אותה, להריץ בדיקה ולשמור. אחרי השמירה צריך להריץ אותה פעם אחת מהאפליקציה, ורק אז אפשר לתזמן אותה.`
          : `The routine draft for ${app} is ready on the phone. Review it, run the check and save it. After saving, run it once from the app; only then can it be scheduled.`;
      case 'build_failed':
        return he
          ? `הטלפון לא הצליח לבנות שגרה מהטיוטה לאפליקציה ${app}. אפשר לבקש שוב, או לבנות את השגרה בעורך באפליקציה.`
          : `The phone could not build a routine from the draft for ${app}. Ask again, or build the routine in the app's editor.`;
      case 'slot_busy':
        return he
          ? 'בטלפון כבר פתוחה טיוטת שגרה אחרת. יש לשמור או לבטל אותה, ואז לבקש שוב.'
          : 'Another routine draft is already open on the phone. Save or discard it, then ask again.';
      case 'expired':
        return he
          ? `הטלפון לא הגיב, ולכן טיוטת השגרה לאפליקציה ${app} לא נבנתה. אפשר לבקש שוב.`
          : `The phone did not answer, so the routine draft for ${app} was not built. You can ask again.`;
      case 'unknown':
        return he
          ? `לא ידוע אם טיוטת השגרה לאפליקציה ${app} הגיעה לטלפון. כדאי לבדוק במסך השגרות באפליקציה, ואם אין שם טיוטה, לבקש שוב.`
          : `It is not known whether the routine draft for ${app} reached the phone. Check the app's routines screen, and if there is no draft, ask again.`;
      case 'preempted':
        return he
          ? 'בניית טיוטת השגרה נעצרה כי שגרה אחרת מתחילה לרוץ. אפשר לבקש שוב אחר כך.'
          : 'Building the routine draft stopped because another routine is starting. You can ask again later.';
    }
  },
};
