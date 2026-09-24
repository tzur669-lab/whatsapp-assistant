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
  budget: BudgetState;
  llmFallbacksToday: number;
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
      `• הודעות החודש: ${isolateLtr(`${report.budget.sent}/${report.budget.remaining + report.budget.sent}`)}`,
      `• נפילות לפרסר גיבוי היום: ${isolateLtr(String(report.llmFallbacksToday))}`,
    ];

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

  /**
   * Tier 3: a button is not enough. The action reaches someone outside this
   * system, so confirming it has to be an act of typing (PLAN §6.5).
   */
  confirmTypedPrompt(summary: string, code: string): string {
    return `${summary}

זו פעולה שיוצאת החוצה. לאישור יש לשלוח: ${isolate(`אשר ${code}`)}`;
  },

  confirmed: 'בוצע.',

  cancelled: 'בוטל.',

  /** The action was undone within the ten minute window. */
  undone: 'הפעולה בוטלה וחזרה למצב הקודם.',

  /** Every way a confirmation can fail, in plain words. */
  confirmExpired: 'האישור פג. יש לשלוח את הבקשה מחדש.',

  confirmNotFound: 'לא נמצאה פעולה שממתינה לאישור.',

  confirmAmbiguous: 'יש יותר מפעולה אחת שממתינה לאישור. יש ללחוץ על הכפתור של הפעולה הרצויה.',

  confirmTapButton: 'יש ללחוץ על אחד הכפתורים.',

  /** A Tier 3 action cannot be confirmed by a tap, only by typing the code. */
  confirmTypedRequired: 'לפעולה הזאת צריך לשלוח את קוד האישור שמופיע בהודעה.',

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
