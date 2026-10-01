/**
 * Replies for the deterministic system commands (PLAN §6.4, §6.9).
 *
 * These never go through the LLM. Every string is code-authored, gender-neutral,
 * ktiv maleh, and dugri — direct, no softeners, which is the expected register
 * for product copy in Hebrew and is not rudeness.
 *
 * Numbers, times and Latin runs are bidi-isolated: without that, `800/1,000`
 * renders reversed inside a Hebrew sentence (PLAN §6.3).
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatWhen } from './format-time.js';
import type { LocalParts } from '../time/tz.js';
import type { BudgetState } from '../policy/window.js';

export type StatusReport = {
  connected: boolean;
  pendingReminders: number;
  /** Absent in the app, which has no message budget (§6.18). */
  budget?: BudgetState;
  llmFallbacksToday: number;
  /** Messages Meta accepted and then reported as undelivered (§6.8). */
  undeliveredToday: number;
  /** The digest hour, or null when it is off (§6.12). */
  digestHour: number | null;
  /** Whether reminders are held over Shabbat and chagim (§6.13). */
  restHold: boolean;
  /** A subscribed feed's event count and last error, or null when none (§6.15). */
  ical: { events: number; lastError: string | null } | null;
  lastErrorCode: string | null;
  paused: boolean;
};

export const statusText = {
  /** `/status` — one message, everything the user needs to judge the system. */
  status(report: StatusReport): string {
    const lines = [
      'מצב המערכת:',
      '',
      `• יומן Google: ${report.connected ? 'מחובר' : `לא מחובר — יש לשלוח ${isolate('/connect google')}`}`,
      `• תזכורות ממתינות: ${isolateLtr(String(report.pendingReminders))}`,
      ...(report.budget
        ? [`• הודעות החודש: ${isolateLtr(`${report.budget.sent}/${report.budget.remaining + report.budget.sent}`)}`]
        : []),
      `• נפילות לפרסר גיבוי היום: ${isolateLtr(String(report.llmFallbacksToday))}`,
    ];

    // Each of these appears only when it has something to say. A status report
    // that lists every feature whether or not it is in use stops being read.
    if (report.digestHour !== null) {
      const clock = isolateLtr(`${String(report.digestHour).padStart(2, '0')}:00`);
      lines.push(`• תקציר יומי: ${clock}`);
    }
    if (report.restHold) {
      lines.push('• תזכורות מושהות בשבת ובחג');
    }
    if (report.ical) {
      const count = isolateLtr(String(report.ical.events));
      lines.push(
        report.ical.lastError === null
          ? `• יומן חיצוני: ${count} אירועים`
          : `• יומן חיצוני: ${count} אירועים, העדכון האחרון נכשל (${isolate(report.ical.lastError)})`,
      );
    }

    if (report.undeliveredToday > 0) {
      // Worth its own line only when it is not zero: a healthy system should
      // not have to read a zero every time it asks how it is doing.
      lines.push(`• הודעות שלא נמסרו ביממה האחרונה: ${isolateLtr(String(report.undeliveredToday))}`);
    }

    if (report.paused) {
      lines.push(`• המערכת מושהית. יש לשלוח ${isolate('/resume')} כדי להפעיל מחדש`);
    }
    if (report.lastErrorCode) {
      lines.push(`• תקלה אחרונה: ${isolate(report.lastErrorCode)}`);
    }

    return lines.join('\n');
  },

  paused: `המערכת מושהית. תזכורות שכבר נקבעו ימשיכו להישלח, אבל שום פעולה חדשה לא תתבצע. יש לשלוח ${isolate('/resume')} כדי להפעיל מחדש.`,

  resumed: 'המערכת פעילה שוב.',

  alreadyPaused: 'המערכת כבר מושהית.',

  alreadyRunning: 'המערכת כבר פעילה.',

  /** `/budget` in the app: there is nothing to count (§6.18). */
  budgetNotInApp: 'באפליקציה אין מגבלת הודעות חודשית.',

  /** `/budget` — the hard cap is 1,000 free messages a month (PLAN §5). */
  budget(state: BudgetState): string {
    const used = isolateLtr(`${state.sent}/${state.sent + state.remaining}`);
    switch (state.level) {
      case 'exhausted':
        return `נגמרה מכסת ההודעות החודשית (${used}). תזכורות יגיעו כהתראה ביומן עד תחילת החודש הבא.`;
      case 'warn':
        return `נותרו ${isolateLtr(String(state.remaining))} הודעות מהמכסה החודשית (${used}). מעבר לזה תזכורות יגיעו כהתראה ביומן.`;
      default:
        return `נשלחו ${used} הודעות החודש.`;
    }
  },

  /** Sent once, when the counter crosses the warning threshold. */
  budgetWarning(state: BudgetState): string {
    return `שימו לב: נוצלו ${isolateLtr(String(state.sent))} מתוך ${isolateLtr(String(state.sent + state.remaining))} ההודעות החודשיות. כשהמכסה תיגמר, תזכורות יגיעו כהתראה ביומן במקום בוואטסאפ.`;
  },

  /** Shown with the confirm/cancel buttons for a Tier 2 action. */
  confirmPrompt(summary: string): string {
    return `${summary}\n\nלאשר?`;
  },

  /** `/city` (2026-10-01). */
  cityIs(city: string, withHowTo: boolean): string {
    const line = `העיר לתחזית ולזמני שבת: ${city}.`;
    return withHowTo ? `${line} לשינוי: ${isolate('/city')} ואחריו שם העיר.` : line;
  },

  cityNotFound(name: string, current: string): string {
    return `לא מצאתי עיר בשם ${name}. העיר נשארה ${current}.`;
  },

  confirmed: 'בוצע.',

  cancelled: 'בוטל.',

  /**
   * `/digest` (PLAN §6.12). Says the hour and says what it will not do, because
   * "on" is ambiguous about whether a quiet day still gets a message.
   */
  digestOn(hour: number): string {
    const clock = isolateLtr(`${String(hour).padStart(2, '0')}:00`);
    return `תקציר יומי יישלח כל יום ב-${clock}. ביום שאין בו כלום לא תישלח הודעה.`;
  },

  digestOff: `התקציר היומי כבוי. להפעלה יש לשלוח ${isolate('/digest 7')} — המספר הוא השעה.`,

  digestUnchanged(hour: number): string {
    const clock = isolateLtr(`${String(hour).padStart(2, '0')}:00`);
    return `התקציר היומי פעיל ונשלח ב-${clock}. לכיבוי: ${isolate('/digest off')}.`;
  },

  digestTurnedOff: 'התקציר היומי כבוי.',

  /**
   * `/shabbat` (PLAN §6.13). Says exactly what it does, including that it holds
   * everything and not only some things — there is no urgency flag to read.
   */
  restHoldOn:
    'תזכורות שזמנן נופל בשבת או בחג יישמרו ויישלחו במוצאי שבת. זה חל על כל התזכורות, ' +
    'בלי חריגים. הזמנים מחושבים לפי שקיעה בירושלים.',

  restHoldOff: `תזכורות יישלחו גם בשבת ובחג. להשהיה יש לשלוח ${isolate('/shabbat on')}.`,

  restHoldUnchanged: `השהיית שבת פעילה. לכיבוי: ${isolate('/shabbat off')}.`,

  restHoldTurnedOff: 'השהיית שבת כבויה. תזכורות יישלחו גם בשבת ובחג.',

  // -- iCal feeds (PLAN §6.15) ------------------------------------------------

  icalSubscribed(events: number): string {
    return `היומן החיצוני מחובר. נקלטו ${isolateLtr(String(events))} אירועים לחודשיים הקרובים. ` +
      'הוא מתעדכן פעם ביום ומופיע ביומן ובתקציר היומי.';
  },

  /** The feed was accepted but came back empty — usually the wrong link. */
  icalEmpty:
    'היומן החיצוני מחובר, אבל לא נמצאו בו אירועים לחודשיים הקרובים. כדאי לוודא שזה קישור ' +
    'ההרשמה ליומן ולא הקישור לצפייה בדפדפן.',

  icalNone: `אין יומן חיצוני מחובר. לחיבור יש לשלוח ${isolate('/ical')} ואחריו קישור ה-ics.`,

  icalRemoved: 'היומן החיצוני נותק. האירועים שלו הוסרו.',

  icalStatus(events: number, errorCode: string | null): string {
    const head = `יומן חיצוני מחובר, ${isolateLtr(String(events))} אירועים שמורים.`;
    return errorCode === null
      ? head
      : `${head}
העדכון האחרון נכשל: ${isolate(errorCode)}. האירועים שנשמרו עדיין מוצגים.`;
  },

  /**
   * A rejected URL says which rule it broke. This is a link the user typed and
   * probably mistyped — unlike a webhook signature, there is nobody to keep in
   * the dark, and "לא תקין" is not something anyone can act on.
   */
  icalRejected(reason: string): string {
    switch (reason) {
      case 'not_https':
        return `הקישור חייב להתחיל ב-${isolate('https://')} (או ${isolate('webcal://')}).`;
      case 'has_credentials':
        return 'הקישור מכיל שם משתמש וסיסמה. צריך קישור הרשמה ציבורי, בלי פרטי התחברות.';
      case 'ip_literal':
      case 'private_host':
        return 'הקישור מצביע על כתובת פנימית ולא על יומן באינטרנט.';
      case 'bad_port':
        return 'הקישור מצביע על פורט לא סטנדרטי. צריך קישור רגיל, בלי מספר פורט.';
      case 'too_long':
        return 'הקישור ארוך מדי.';
      default:
        return 'זה לא נראה כמו קישור תקין. צריך את קישור ההרשמה ליומן, שמסתיים בדרך כלל ב-ics.';
    }
  },

  // -- birthdays (PLAN §6.16) -------------------------------------------------

  birthdayAdded(name: string, day: number, month: number): string {
    return `נשמר: יום ההולדת של ${isolate(name)} ב-${isolateLtr(`${day}.${month}`)}. ` +
      'תופיע תזכורת בתקציר היומי באותו יום.';
  },

  birthdayRemoved(name: string): string {
    return `${isolate(name)} הוסר/ה מרשימת ימי ההולדת.`;
  },

  birthdayNotFound(name: string): string {
    return `לא נמצא/ה ${isolate(name)} ברשימה.`;
  },

  birthdayList(entries: ReadonlyArray<{ name: string; day: number; month: number }>): string {
    if (entries.length === 0) return statusText.birthdayEmpty;
    const lines = entries.map(
      (entry) => `• ${isolateLtr(`${entry.day}.${entry.month}`)} — ${isolate(entry.name)}`,
    );
    return ['ימי הולדת:', '', ...lines].join('\n');
  },

  birthdayEmpty: `אין ימי הולדת ברשימה. להוספה: ${isolate('/birthday דנה 14.3')}.`,

  birthdayShape: `הפורמט הוא ${isolate('/birthday דנה 14.3')} — שם ואחריו יום.חודש. ` +
    `למחיקה: ${isolate('/birthday מחק דנה')}.`,

  birthdayBadDate: 'התאריך הזה לא קיים. צריך יום וחודש תקינים, למשל ⁨14.3⁩.',

  birthdayListFull: 'רשימת ימי ההולדת מלאה.',

  icalFetchFailed(errorCode: string): string {
    return `לא הצלחתי להוריד את היומן (${isolate(errorCode)}). כדאי לוודא שהקישור פתוח לכל מי שמחזיק בו.`;
  },

  /** The action was undone within the ten minute window. */
  undone: 'הפעולה בוטלה וחזרה למצב הקודם.',

  /** Every way a confirmation can fail, in plain words. */
  confirmExpired: 'האישור פג. יש לשלוח את הבקשה מחדש.',

  confirmNotFound: 'לא נמצאה פעולה שממתינה לאישור.',

  confirmAmbiguous: 'יש יותר מפעולה אחת שממתינה לאישור. יש ללחוץ על הכפתור של הפעולה הרצויה.',

  confirmTapButton: 'יש ללחוץ על אחד הכפתורים.',

  /** A Tier 3 action cannot be confirmed by a tap, only by typing the code. */

  /** A reminder that arrived late, and by how much. */
  lateBy(minutes: number): string {
    return `(באיחור של ${isolateLtr(String(minutes))} דק׳)`;
  },

  missedWhileOffline: '(תזכורת שפוספסה בזמן שהמערכת לא הייתה זמינה)',

  /** A reminder that will be delivered through the calendar instead. */
  calendarFallback(local: LocalParts): string {
    return `התזכורת נקבעה ל${formatWhen(local, 'he')}. היא תגיע כהתראה ביומן, כי חלון ההודעות של וואטסאפ ייסגר עד אז.`;
  },

  reminderSet(local: LocalParts): string {
    return `נקבעה תזכורת ל${formatWhen(local, 'he')}.`;
  },

  noReminders: 'אין תזכורות ממתינות.',

  /** A tool hit its own hourly or daily cap. The cap is code, not chat (§6.4). */
  rateLimited: 'הגעת למגבלת השימוש של הפעולה הזאת. כדאי לנסות שוב מאוחר יותר.',

  /** The tool parsed correctly but has no executable body yet. */
  notAvailableYet: 'הפעולה הזאת עדיין לא זמינה.',
} as const;
