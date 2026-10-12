/**
 * What the assistant says about the screen agent (PLAN §6.28). Code-rendered.
 *
 * Wording follows what is known, never more (§9.8): a task the model called
 * done is "from what I saw on the screen", never "✓ done"; an end after an
 * action says some actions may have run; an action that may have run is never
 * claimed either way. The model's three free strings appear only as a
 * quotation, capped, scrubbed again and link-defanged. The app's label and
 * the task's own words are isolated so Latin text cannot reorder the Hebrew.
 * The approval card carries no screen text: the app, the kind of action and
 * why it stopped; the phone's notification shows the rest.
 */
import { isolate, isolateLtr } from './bidi.js';
import type { Lang } from './format-time.js';
import { defangLinks, scrubForModel } from '../security/scrub.js';
import type { RiskWhy } from '../agent/screen-policy.js';
import { MAX_MODEL_TEXT } from '../agent/screen-step.js';
import { SCREEN_TASKS_PER_DAY } from '../tools/screen-store.js';
import type { Ended, HistoryEntry, ScreenAction } from '../tools/screen-store.js';

export type ScreenQuestion =
  | 'tainted'
  | 'not_app'
  | 'no_apps'
  | 'app'
  | 'app_unknown'
  | 'task'
  | 'input_not_said'
  | 'daily_cap'
  | 'routine_soon'
  | 'busy';

export type ScreenCardView = { appLabel: string; task: string; inputs: readonly string[] };

/** A model string on its way to the chat: capped, scrubbed, defanged, quoted. */
export function quoteModelText(text: string): string {
  const capped = text.replace(/\s+/g, ' ').trim().slice(0, MAX_MODEL_TEXT);
  return `«${isolate(defangLinks(scrubForModel(capped)))}»`;
}

function apps(labels: readonly string[]): string {
  return labels.map(isolate).join(', ');
}

const ACTION_HE: Readonly<Record<ScreenAction['kind'], string>> = {
  tap: 'לחיצה',
  type: 'הקלדה',
  submit: 'Enter',
  scroll: 'גלילה',
  back: 'חזרה',
  wait: 'המתנה',
};

const ACTION_EN: Readonly<Record<ScreenAction['kind'], string>> = {
  tap: 'tap',
  type: 'typing',
  submit: 'Enter',
  scroll: 'scroll',
  back: 'back',
  wait: 'wait',
};

const WHY_HE: Readonly<Record<RiskWhy, string>> = {
  sensitive: 'נראה כמו שליחה, תשלום או מחיקה',
  generic: 'כפתור כללי — ייתכן שזה שולח טופס',
  unlabelled: 'כפתור בלי שם',
  after_form: 'אחרי מילוי שדה',
  submit_not_search: 'Enter בשדה שאינו שדה חיפוש — ייתכן שזה שולח טופס',
  ask_every_tap: 'באפליקציה הזו נבחר לאשר כל לחיצה',
};

const WHY_EN: Readonly<Record<RiskWhy, string>> = {
  sensitive: 'it looks like sending, paying or deleting',
  generic: 'a generic button — it may submit a form',
  unlabelled: 'a button with no name',
  after_form: 'after a field was filled in',
  submit_not_search: 'Enter in a field that is not a search field — it may submit a form',
  ask_every_tap: 'this app is set to ask before every tap',
};

/** Why a task ended, as the user reads it. Codes not listed read as a general stop. */
const REASON_HE: Readonly<Record<string, string>> = {
  tree_unusable: 'לא הצלחתי לקרוא את המסך הזה',
  model_cannot_see: 'לא הצלחתי לקרוא את המסך הזה',
  model_not_found: 'לא מצאתי במסך את מה שחיפשתי',
  model_login_needed: 'צריך להתחבר לאפליקציה',
  model_blocked: 'משהו במסך חוסם את ההמשך',
  model_off_task: 'אי אפשר לבצע את המשימה באפליקציה הזו',
  model_other: 'המשימה לא הושלמה',
  model_error: 'המודל ענה תשובה שאי אפשר להשתמש בה',
  no_effect: 'לא ראיתי שינוי במסך',
  no_progress: 'האפליקציה לא קיבלה את הפעולות',
  screen_changed: 'המסך השתנה לפני הפעולה',
  target_ambiguous: 'מצאתי במסך כמה רכיבים זהים',
  locked: 'הטלפון נעול',
  app_missing: 'האפליקציה לא מותקנת בטלפון',
  app_not_front: 'האפליקציה לא נפתחה',
  launch_confirm: 'הטלפון ביקש אישור לפתוח את האפליקציה. יש לאשר את הפתיחה, או לפתוח אותה ולכתוב "נסה שוב"',
  left_app: 'המסך עבר לאפליקציה אחרת',
  service_off: 'שירות הנגישות של האפליקציה כבוי',
  deadline: 'עברו 4 הדקות שהוקצו למשימה',
  step_limit: 'הגעתי למספר הצעדים המרבי',
  budget: 'נגמרה מכסת הטוקנים של המשימה',
  quota: 'מכסת המודל להיום נגמרה',
  busy: 'הבוט היה עסוק זמן רב מדי',
  not_claimed: 'הטלפון לא הגיב',
  unreachable: 'לא היה חיבור לשרת',
  sealed_missing: 'פרטי המשימה לא נמצאו',
  protocol: 'הטלפון והשרת יצאו מסנכרון',
  uncertain: 'לא ידוע אם הפעולה האחרונה בוצעה',
  not_allowed: 'האפליקציה לא ברשימה המאושרת',
  error: 'הייתה שגיאה בטלפון',
};

const REASON_EN: Readonly<Record<string, string>> = {
  tree_unusable: 'I could not read this screen',
  model_cannot_see: 'I could not read this screen',
  model_not_found: 'I did not find what I was looking for on the screen',
  model_login_needed: 'the app needs a login',
  model_blocked: 'something on the screen blocks the way',
  model_off_task: 'this task cannot be done in this app',
  model_other: 'the task was not completed',
  model_error: 'the model gave an answer that could not be used',
  no_effect: 'I saw no change on the screen',
  no_progress: 'the app did not accept the actions',
  screen_changed: 'the screen changed before the action',
  target_ambiguous: 'I found several identical elements on the screen',
  locked: 'the phone is locked',
  app_missing: 'the app is not installed',
  app_not_front: 'the app did not open',
  launch_confirm: 'the phone asked to allow opening the app. Allow it, or open the app and write "try again"',
  left_app: 'the screen moved to another app',
  service_off: "the app's accessibility service is off",
  deadline: 'the 4 minutes for the task ran out',
  step_limit: 'I reached the most steps a task may take',
  budget: "the task's token budget ran out",
  quota: "the model's quota for today ran out",
  busy: 'the bot was busy for too long',
  not_claimed: 'the phone did not answer',
  unreachable: 'there was no connection to the server',
  sealed_missing: "the task's details were not found",
  protocol: 'the phone and the server fell out of step',
  uncertain: 'it is not known whether the last action ran',
  not_allowed: 'the app is not on the approved list',
  error: 'there was an error on the phone',
};

function reasonOf(reason: string, lang: Lang): string {
  return (lang === 'he' ? REASON_HE : REASON_EN)[reason] ?? (lang === 'he' ? 'המשימה נעצרה' : 'the task stopped');
}

/** The steps the phone reported done, as codes in words: "הקלדה, Enter, לחיצה". */
function doneSteps(history: readonly HistoryEntry[], lang: Lang): string | null {
  const done = history.filter((h) => h.r === 'd' && h.k !== 'wait').map((h) => (lang === 'he' ? ACTION_HE : ACTION_EN)[h.k]);
  return done.length === 0 ? null : done.join(', ');
}

export const screenText = {
  /** The confirmation's question: the app, the task and every text it may type, word for word. */
  preview(view: ScreenCardView, lang: Lang): string {
    const inputs = view.inputs.map((value, i) => `${isolateLtr(String(i + 1))}. «${isolate(value)}»`);
    if (lang !== 'he') {
      return [
        `Start the screen agent in ${isolate(view.appLabel)}?`,
        `Task: «${isolate(view.task)}»`,
        inputs.length > 0 ? `It may type only:\n${inputs.join('\n')}` : 'It will not type anything.',
        'Before a tap that looks like sending, paying or deleting, it will ask again.',
      ].join('\n');
    }
    return [
      `להפעיל את סוכן המסך באפליקציה ${isolate(view.appLabel)}?`,
      `המשימה: «${isolate(view.task)}»`,
      inputs.length > 0 ? `מותר להקליד רק:\n${inputs.join('\n')}` : 'לא תהיה הקלדה.',
      'לפני לחיצה שנראית כמו שליחה, תשלום או מחיקה, תהיה בקשת אישור נוספת.',
    ].join('\n');
  },

  started(appLabel: string, lang: Lang): string {
    return lang === 'he'
      ? `סוכן המסך מתחיל באפליקציה ${isolate(appLabel)}. אפשר לעצור בכל רגע, מההתראה בטלפון או כאן.`
      : `The screen agent is starting in ${isolate(appLabel)}. It can be stopped at any moment, from the phone's notification or here.`;
  },

  /** A message while a task runs: answered by code, no model (§5). */
  busy(appLabel: string, lang: Lang): string {
    return lang === 'he'
      ? `סוכן המסך עובד עכשיו באפליקציה ${isolate(appLabel)}. אפשר לעצור אותו, או לכתוב שוב כשיסיים.`
      : `The screen agent is working in ${isolate(appLabel)} now. Stop it, or write again when it is done.`;
  },

  stopButton(lang: Lang): string {
    return lang === 'he' ? 'עצור' : 'Stop';
  },

  approveButton(lang: Lang): string {
    return lang === 'he' ? 'אישור' : 'Approve';
  },

  rejectButton(lang: Lang): string {
    return lang === 'he' ? 'דחייה' : 'Reject';
  },

  /** The chat's approval card: no screen text, only what kind of action and why. */
  approvalCard(appLabel: string, kind: ScreenAction['kind'], why: RiskWhy, lang: Lang): string {
    if (lang !== 'he') {
      return `The screen agent stopped before a ${ACTION_EN[kind]} in ${isolate(appLabel)}: ${WHY_EN[why]}. The details are in the phone's notification. Approve this action? With no answer in 2 minutes, the task stops.`;
    }
    return `סוכן המסך עצר לפני ${ACTION_HE[kind]} באפליקציה ${isolate(appLabel)}: ${WHY_HE[why]}. הפרטים בהתראה בטלפון. לאשר את הפעולה הזו? בלי תשובה תוך 2 דקות, המשימה תיעצר.`;
  },

  released(lang: Lang): string {
    return lang === 'he' ? 'אושר. הפעולה תתבצע עכשיו.' : 'Approved. The action runs now.';
  },

  alreadyDecided(lang: Lang): string {
    return lang === 'he' ? 'כבר הוחלט על הפעולה הזו.' : 'This action was already decided.';
  },

  notRunning(lang: Lang): string {
    return lang === 'he' ? 'סוכן המסך לא עובד עכשיו.' : 'The screen agent is not running.';
  },

  /** The one message when a task ends. `modelText` only with done, unsure or ask. */
  ended(ended: Ended, modelText: string | undefined, lang: Lang): string {
    const app = isolate(ended.task.appLabel);
    const steps = doneSteps(ended.task.history, lang);
    const he = lang === 'he';
    const reason = reasonOf(ended.reason, lang);
    switch (ended.outcome) {
      case 'completed_unverified': {
        const quote = modelText !== undefined ? quoteModelText(modelText) : '';
        return he
          ? [`לפי מה שראיתי על המסך באפליקציה ${app}: ${quote}`, steps ? `פעולות: ${steps}.` : null, 'לא אימתתי מעבר למה שהופיע על המסך.']
              .filter((line) => line !== null)
              .join('\n')
          : [`From what I saw on the screen in ${app}: ${quote}`, steps ? `Actions: ${steps}.` : null, 'I did not check beyond what the screen showed.']
              .filter((line) => line !== null)
              .join('\n');
      }
      case 'inconclusive': {
        const quote = modelText !== undefined ? quoteModelText(modelText) : '';
        return he
          ? `לא הצלחתי לקבוע. מה שראיתי על המסך באפליקציה ${app}: ${quote}`
          : `I could not tell. What I saw on the screen in ${app}: ${quote}`;
      }
      case 'asked': {
        const quote = modelText !== undefined ? quoteModelText(modelText) : '';
        return he
          ? `סוכן המסך צריך פרט נוסף כדי להמשיך: ${quote}\nהתשובה תהיה משימה חדשה, עם אישור חדש.`
          : `The screen agent needs one more detail to go on: ${quote}\nThe answer will be a new task, with a new approval.`;
      }
      case 'failed_before_action':
        return he
          ? `סוכן המסך עצר באפליקציה ${app} בלי לבצע שום פעולה: ${reason}.`
          : `The screen agent stopped in ${app} without doing anything: ${reason}.`;
      case 'failed_after_action':
        return he
          ? `סוכן המסך עצר באפליקציה ${app}: ${reason}. ייתכן שחלק מהפעולות בוצעו${steps ? `: ${steps}` : ''}.`
          : `The screen agent stopped in ${app}: ${reason}. Some actions may have run${steps ? `: ${steps}` : ''}.`;
      case 'unknown':
        return he
          ? `סוכן המסך עצר באפליקציה ${app}: ${reason}. ייתכן שהפעולה האחרונה בוצעה, והיא לא תנוסה שוב. כדאי לבדוק במסך.`
          : `The screen agent stopped in ${app}: ${reason}. The last action may have run, and it will not be tried again. Check the screen.`;
      case 'stopped':
        return stoppedText(ended.reason, app, steps, lang);
    }
  },

  question(what: ScreenQuestion, lang: Lang, labels: readonly string[] = []): string {
    const he = lang === 'he';
    switch (what) {
      case 'tainted':
        return he
          ? 'אי אפשר להפעיל את סוכן המסך מתוך טקסט ששותף או הועבר. אפשר לכתוב את הבקשה במילים שלך.'
          : 'The screen agent cannot start from shared or forwarded text. Write the request in your own words.';
      case 'not_app':
        return he ? 'סוכן המסך עובד רק מתוך האפליקציה של הבוט.' : "The screen agent works only from the bot's app.";
      case 'no_apps':
        return he
          ? 'עוד לא נבחרו אפליקציות לסוכן המסך. אפשר לבחור אותן באפליקציה: ☰ ← ⚙️ סוכן מסך.'
          : 'No apps are turned on for the screen agent yet. Choose them in the app: ☰ → ⚙️ Screen agent.';
      case 'app':
        return he ? `באיזו אפליקציה? אפשר: ${apps(labels)}.` : `In which app? These are on: ${apps(labels)}.`;
      case 'app_unknown':
        return he
          ? `האפליקציה הזו לא ברשימה של סוכן המסך. אפשר: ${apps(labels)}. אפליקציות נוספות מוסיפים ב-☰ ← ⚙️ סוכן מסך.`
          : `That app is not on the screen agent's list. These are on: ${apps(labels)}. Add more in ☰ → ⚙️ Screen agent.`;
      case 'task':
        return he ? 'מה לעשות באפליקציה?' : 'What should it do in the app?';
      case 'input_not_said':
        return he
          ? 'טקסט להקלדה חייב להופיע כמו שהוא בהודעה עצמה. אפשר לכתוב את הבקשה שוב, עם הטקסט המדויק.'
          : 'Text to type must appear as is in the message itself. Write the request again with the exact text.';
      case 'daily_cap':
        return he
          ? `סוכן המסך כבר הופעל ${isolateLtr(String(SCREEN_TASKS_PER_DAY))} פעמים היום, וזה המקסימום. אפשר לנסות שוב מחר.`
          : `The screen agent already ran ${SCREEN_TASKS_PER_DAY} times today, the most a day. Try again tomorrow.`;
      case 'routine_soon':
        return he
          ? `שגרה אמורה לרוץ בעוד פחות מ-${isolateLtr('7')} דקות, ולכן סוכן המסך לא יתחיל עכשיו.`
          : 'A routine is due in less than 7 minutes, so the screen agent will not start now.';
      case 'busy':
        return he
          ? 'סוכן המסך כבר עובד על משימה. אפשר לעצור אותה, או לחכות שתסתיים.'
          : 'The screen agent is already on a task. Stop it, or wait for it to finish.';
    }
  },
};

function stoppedText(reason: string, app: string, steps: string | null, lang: Lang): string {
  const he = lang === 'he';
  const before = steps ? (he ? ` פעולות שבוצעו קודם: ${steps}.` : ` Actions done before: ${steps}.`) : '';
  switch (reason) {
    case 'rejected':
      return he
        ? `הפעולה נדחתה, וסוכן המסך נעצר. הפעולה הזו לא בוצעה.${before}`
        : `The action was rejected and the screen agent stopped. That action did not run.${before}`;
    case 'approval_timeout':
      return he
        ? `לא התקבלה תשובה לבקשת האישור, וסוכן המסך נעצר. הפעולה הזו לא בוצעה.${before}`
        : `The approval was not answered and the screen agent stopped. That action did not run.${before}`;
    case 'stopped_restart':
      return he
        ? `המשימה נעצרה כי האפליקציה בטלפון הופעלה מחדש. הפעולה הממתינה לא בוצעה.${before}`
        : `The task stopped because the app on the phone restarted. The waiting action did not run.${before}`;
    case 'preempted':
      return he
        ? `סוכן המסך נעצר באפליקציה ${app} כי שגרה מתחילה לרוץ.${before}`
        : `The screen agent stopped in ${app} because a routine is starting.${before}`;
    case 'app_removed':
      return he
        ? `האפליקציה ${app} הוסרה מהרשימה של סוכן המסך, והמשימה נעצרה.${before}`
        : `${app} was taken off the screen agent's list, and the task stopped.${before}`;
    case 'not_allowed':
      return he
        ? `האפליקציה ${app} לא ברשימה של סוכן המסך, והמשימה לא רצה.`
        : `${app} is not on the screen agent's list, so the task did not run.`;
    default:
      return he ? `סוכן המסך נעצר באפליקציה ${app}.${before}` : `The screen agent stopped in ${app}.${before}`;
  }
}
