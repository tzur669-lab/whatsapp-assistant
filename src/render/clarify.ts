/**
 * Turning a refusal into a question (PLAN §6.3, §6.4).
 *
 * `src/time/resolve.ts` and each tool's `resolve` return stable reason codes and
 * never prose. This file is the single place those become words, which is what
 * lets the same refusal be asked in Hebrew or English without the rules
 * knowing either language exists.
 *
 * Every question names what is missing. "לא הבנתי" on its own tells the user
 * nothing they can act on, and the whole reason this system asks instead of
 * guessing is that asking is cheap only when the question is a good one.
 */
import { eventText } from './events.js';
import { isolateLtr } from './bidi.js';
import { callText } from './calls.js';
import { phoneQuestion } from './phone.js';
import { personalQuestion } from './personal.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { Clarify, TargetChoice } from '../tools/types.js';
import type { ClarifyTime } from '../time/resolve.js';
import type { AskedSlot } from '../confirm/questions.js';
import { localPartsOf, ZONE } from '../time/tz.js';

export function renderClarify(clarify: Clarify, lang: Lang): string {
  switch (clarify.code) {
    case 'missing_slot':
      return missingSlot(clarify.slot, lang);
    case 'time':
      return timeQuestion(clarify.detail, lang);
    case 'not_found':
      return lang === 'he'
        ? 'לא מצאתי משהו שמתאים לתיאור. אפשר לנסח אחרת, או לבקש את הרשימה.'
        : 'Nothing matches that. Try different wording, or ask for the list.';
    case 'ambiguous':
      return chooseOne(clarify.choices, lang);
    case 'nothing_scheduled':
      return lang === 'he' ? 'אין תזכורות ממתינות.' : 'No reminders pending.';
    case 'grant_missing':
      return eventText.grantNotConnected(clarify.grant, lang);

    case 'not_connected':
      return lang === 'he'
        ? `יומן Google לא מחובר. יש לשלוח ${isolateLtr('/connect google')}.`
        : `Google Calendar is not connected. Send ${isolateLtr('/connect google')}.`;
    case 'call_number_refused':
      return callText.numberRefused(lang);
    case 'phone_missing':
      return phoneQuestion(clarify.what, lang);
    case 'personal':
      return personalQuestion(clarify.what, lang);
    case 'leave_too_late':
      return lang === 'he'
        ? 'כבר מאוחר מדי: הזמן לצאת לאירוע הזה עבר, או שנשארה פחות מדקה.'
        : 'Too late: the time to leave for that event has already passed.';
  }
}

/**
 * Asking again, after a reply that was clearly an attempt at the answer but did
 * not settle it — "בערב" to "באיזו שעה?" (PLAN §6.11, R11).
 *
 * The second asking is more concrete than the first. Repeating "באיזו שעה?"
 * verbatim reads as though the reply was not received at all, and gives the
 * user nothing new to work with; an example does.
 */
export function reAsk(asked: AskedSlot, lang: Lang): string {
  if (lang === 'en') {
    switch (asked) {
      case 'time':
        return `What time exactly? For example ${isolateLtr('8')} or ${isolateLtr('20:30')}.`;
      case 'when':
        return 'When? A day, a time, or both.';
      case 'date':
        return `Which day? For example tomorrow, Sunday, or ${isolateLtr('25/9')}.`;
      case 'duration':
        return `How long? Say the unit — ${isolateLtr('45')} minutes, or an hour and a half.`;
      case 'text':
        return 'What should the reminder say? A short sentence is enough.';
      case 'title':
        return 'What is the meeting? A short name is enough.';
      case 'target':
        return 'Which one? Describe it, or ask for the list.';
    }
  }

  switch (asked) {
    case 'time':
      return `באיזו שעה בדיוק? למשל ${isolateLtr('8')} או ${isolateLtr('20:30')}.`;
    case 'when':
      return 'למתי? אפשר לציין יום, שעה, או שניהם.';
    case 'date':
      return `באיזה יום? למשל מחר, יום ראשון, או ${isolateLtr('25.9')}.`;
    case 'duration':
      return `כמה זמן? צריך לציין יחידה — ${isolateLtr('45')} דקות, או שעה וחצי.`;
    case 'text':
      return 'על מה להזכיר? מספיק משפט קצר.';
    case 'title':
      return 'מה הפגישה? מספיק שם קצר.';
    case 'target':
      return 'על איזו מהן מדובר? אפשר לתאר אותה, או לבקש את הרשימה.';
  }
}

function missingSlot(
  slot: 'text' | 'time' | 'target' | 'title' | 'date' | 'duration',
  lang: Lang,
): string {
  if (lang === 'en') {
    switch (slot) {
      case 'text':
        return 'What should the reminder say?';
      case 'title':
        return 'What is the meeting about?';
      case 'time':
        return 'What time?';
      case 'date':
        return 'Which day?';
      case 'duration':
        return 'How long?';
      case 'target':
        return 'Which one? Describe it, or ask for the list.';
    }
  }

  switch (slot) {
    case 'text':
      return 'על מה להזכיר?';
    case 'title':
      return 'מה הפגישה?';
    case 'time':
      // The one refusal this system makes most often, and on purpose: a
      // defaulted time is a reminder that fires at the wrong hour (R11).
      return 'באיזו שעה?';
    case 'date':
      return 'באיזה יום?';
    case 'duration':
      // R11: no default duration. An hour guessed here writes a wrong end time
      // into a shared calendar, where someone else will read it as fact.
      return 'כמה זמן?';
    case 'target':
      return 'על איזו מהן מדובר? אפשר לתאר אותה, או לבקש את הרשימה.';
  }
}

function chooseOne(choices: readonly TargetChoice[], lang: Lang): string {
  const lines = choices.map((choice, index) => `${isolateLtr(String(index + 1))}. ${choice.label}`);
  const header =
    lang === 'he' ? 'יש כמה שמתאימות. באיזו מדובר?' : 'Several match. Which one?';
  return [header, '', ...lines].join('\n');
}

function timeQuestion(detail: ClarifyTime, lang: Lang): string {
  const he = lang === 'he';

  switch (detail.reason) {
    case 'missing_time':
      return he ? 'באיזו שעה?' : 'What time?';

    case 'already_past':
      return he
        ? 'הזמן הזה כבר עבר. למתי לקבוע?'
        : 'That time has already passed. When should it be?';

    case 'unlikely_hour': {
      // A bare small-hours number is usually a misread, not a 3am plan. The
      // suggestion is offered rather than applied (R5).
      const suggested = detail.suggestion
        ? formatWhen(localPartsOf(detail.suggestion.utcMs, ZONE), lang)
        : null;
      if (!suggested) {
        return he ? 'זו שעה לא שגרתית. כדאי לציין בוקר או ערב.' : 'Unusual hour — say morning or evening.';
      }
      return he
        ? `התכוונת ל${suggested}? אם לא, כדאי לציין בוקר או לילה.`
        : `Did you mean ${suggested}? If not, say morning or night.`;
    }

    case 'nonexistent_local_time':
      // Spring forward: the clock skips this hour, so it never happens.
      return he
        ? 'השעה הזאת לא קיימת בתאריך הזה בגלל מעבר שעון קיץ. כדאי לבחור שעה אחרת.'
        : 'That time does not exist on that date — the clocks move forward. Pick another time.';

    case 'ambiguous_local_time': {
      // Fall back: the clock passes this hour twice, so there are two instants.
      const options = (detail.options ?? []).map(
        (option) => formatWhen(localPartsOf(option.utcMs, ZONE), lang),
      );
      const header = he
        ? 'השעה הזאת מופיעה פעמיים בלילה של מעבר השעון. לאיזו מהן?'
        : 'The clocks go back that night, so that time happens twice. Which one?';
      return [header, ...options.map((option, i) => `${isolateLtr(String(i + 1))}. ${option}`)].join('\n');
    }

    case 'recurring_dst':
      // A recurring time that a clock change skips or repeats on one of its
      // days. That later day cannot ask, so the rule is asked about now (R2).
      return he
        ? 'בגלל מעבר שעון, השעה הזאת לא קיימת או מופיעה פעמיים באחד הימים. כדאי לבחור שעה אחרת, למשל אחרי 03:00.'
        : 'A clock change skips or repeats that time on one of the days. Pick another time, for example after 03:00.';

    case 'small_hours_relative_date':
      // "מחר" said at 02:00 means different days to different people (R6).
      return he
        ? 'עכשיו אחרי חצות, אז לא ברור לאיזה יום הכוונה. אפשר לציין את התאריך?'
        : 'It is past midnight, so the day is unclear. Which date?';

    case 'weekday_is_today':
      return he
        ? 'זה אותו יום בשבוע כמו היום. התכוונת להיום, או לשבוע הבא?'
        : 'That is today. Did you mean today, or next week?';

    case 'yearless_date_far_away':
      return he ? 'לא ברור לאיזו שנה. אפשר לציין?' : 'Which year?';

    case 'duration_too_long':
      return he ? 'הטווח ארוך מדי. אפשר לציין תאריך במקום?' : 'That is too far out. Give a date instead.';

    default:
      // invalid_time, invalid_weekday, invalid_offset, nonexistent_date,
      // invalid_duration: the input did not describe a real moment.
      return he
        ? 'לא הצלחתי להבין את התאריך או השעה. אפשר לנסח מחדש?'
        : 'I could not read that date or time. Try rephrasing?';
  }
}
