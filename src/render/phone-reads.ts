/**
 * What the phone read, in words (PLAN §6.21).
 *
 * Code renders the list; the model gets a scrubbed copy of this text as the
 * tool's result, and the user gets this text itself when the model does not get
 * to word an answer. Everything in an item was written by someone else, so it
 * is cleaned first: one line per item, no control or direction-override
 * characters that could make it render as something it is not.
 */
import { isolate } from './bidi.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { PhoneItem, PhoneReadInput, PhoneReadKind } from '../tools/phone-reads.js';

/** C0/C1 controls and every bidi embedding, override and isolate character. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function cleanItemText(value: string | undefined): string {
  return (value ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

function when(at: number | undefined, lang: Lang): string {
  return at === undefined ? '' : `${formatWhen(localPartsOf(at, ZONE), lang)} · `;
}

/** The list the phone sent back, or a plain "nothing" line. */
export function phoneReadText(query: PhoneReadInput, items: readonly PhoneItem[], lang: Lang): string {
  const he = lang === 'he';

  switch (query.kind) {
    case 'contacts': {
      const names = [...new Set(items.map((item) => cleanItemText(item.name)).filter((name) => name.length > 0))];
      if (names.length === 0) {
        return he ? 'לא נמצא באנשי הקשר שם שמתאים לחיפוש.' : 'No contact name matches that.';
      }
      return he
        ? `באנשי הקשר נמצאו: ${names.map(isolate).join(', ')}`
        : `In the contacts: ${names.map(isolate).join(', ')}`;
    }

    case 'notifications': {
      const lines = items
        .map((item) => {
          const app = cleanItemText(item.app);
          const title = cleanItemText(item.title);
          const text = cleanItemText(item.text);
          const body = [title, text].filter((part) => part.length > 0).join(': ');
          if (body.length === 0) return null;
          return `• ${when(item.at, lang)}${app ? `${isolate(app)} · ` : ''}${body}`;
        })
        .filter((line): line is string => line !== null);
      if (lines.length === 0) {
        return he ? 'אין התראות שמתאימות לבקשה.' : 'No notifications match that.';
      }
      return [he ? 'התראות בטלפון:' : 'Notifications on the phone:', ...lines].join('\n');
    }

    case 'sms': {
      const lines = items
        .map((item) => {
          const sender = cleanItemText(item.sender);
          const text = cleanItemText(item.text);
          if (text.length === 0) return null;
          return `• ${when(item.at, lang)}${sender ? `${isolate(sender)}: ` : ''}${text}`;
        })
        .filter((line): line is string => line !== null);
      if (lines.length === 0) {
        return he ? 'אין הודעות SMS שמתאימות לבקשה.' : 'No SMS messages match that.';
      }
      return [he ? 'הודעות SMS:' : 'SMS messages:', ...lines].join('\n');
    }

    case 'calls': {
      const lines = items.map((item) => {
        const caller = cleanItemText(item.sender) || (he ? 'מספר לא מזוהה' : 'Unknown number');
        const label = callLabel(cleanItemText(item.title), lang);
        return `• ${when(item.at, lang)}${isolate(caller)}${label ? ` · ${label}` : ''}`;
      });
      if (lines.length === 0) {
        if (query.missed) return he ? 'אין שיחות שלא נענו.' : 'No missed calls.';
        return he ? 'אין שיחות שמתאימות לבקשה.' : 'No calls match that.';
      }
      const title = query.missed ? (he ? 'שיחות שלא נענו:' : 'Missed calls:') : he ? 'שיחות אחרונות:' : 'Recent calls:';
      return [title, ...lines].join('\n');
    }
  }
}

const CALL_LABELS: Readonly<Record<string, { he: string; en: string }>> = {
  missed: { he: 'לא נענתה', en: 'missed' },
  incoming: { he: 'נכנסת', en: 'incoming' },
  outgoing: { he: 'יוצאת', en: 'outgoing' },
  rejected: { he: 'נדחתה', en: 'declined' },
};

/** A call's direction, from the closed list the phone sends; anything else is left out. */
function callLabel(title: string, lang: Lang): string {
  const label = CALL_LABELS[title];
  return label ? label[lang] : '';
}

/** The phone could not read: the permission is off, or this build cannot. */
export function phoneReadRefused(kind: PhoneReadKind, status: 'denied' | 'unsupported', lang: Lang): string {
  const he = lang === 'he';
  if (status === 'unsupported') {
    return he
      ? 'הגרסה של האפליקציה בטלפון לא יודעת לקרוא את זה. צריך לעדכן אותה.'
      : 'The app on the phone cannot read that. It needs an update.';
  }
  switch (kind) {
    case 'contacts':
      return he
        ? 'לאפליקציה אין הרשאה לאנשי הקשר. אפשר לאשר אותה במסך ההגדרות של האפליקציה.'
        : 'The app has no access to the contacts. It can be granted in the app settings.';
    case 'notifications':
      return he
        ? 'לאפליקציה אין גישה להתראות. אפשר לאשר אותה במסך ההגדרות של האפליקציה.'
        : 'The app has no access to notifications. It can be granted in the app settings.';
    case 'sms':
      return he
        ? 'לאפליקציה אין הרשאה לקרוא SMS. אפשר לאשר אותה במסך ההגדרות של האפליקציה.'
        : 'The app has no permission to read SMS. It can be granted in the app settings.';
    case 'calls':
      return he
        ? 'לאפליקציה אין הרשאה לקרוא את יומן השיחות. אפשר לאשר אותה במסך ההגדרות של האפליקציה.'
        : 'The app has no permission to read the call log. It can be granted in the app settings.';
  }
}
