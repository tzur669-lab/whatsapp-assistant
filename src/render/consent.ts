/**
 * The consent card and `/consents`, in words (smart conversations, slice 5,
 * 2026-10-08).
 *
 * Code-authored, like every reply that asks or reports. Gender-neutral, ktiv
 * maleh, dugri. A source is named, never its data: the card goes out before
 * anything was read. Latin runs are isolated (PLAN §6.3).
 */
import type { OutboundButton } from '../channels/types.js';
import type { ConsentSource } from '../tools/registry.js';
import { consentButtonId, mayKeepForConversation } from '../agent/consents.js';
import { isolate } from './bidi.js';
import type { Lang } from './format-time.js';

/** `he`: the source as a name, with its article; `heTo`: the same after ל־ ("access to"). */
const NAMES: Readonly<Record<ConsentSource, { he: string; heTo: string; en: string }>> = {
  calendar: { he: 'היומן', heTo: 'ליומן', en: 'Calendar' },
  reminders: { he: 'התזכורות', heTo: 'לתזכורות', en: 'Reminders' },
  tasks: { he: `המשימות ב־${isolate('Google Tasks')}`, heTo: `למשימות ב־${isolate('Google Tasks')}`, en: 'Google Tasks' },
  mail: { he: `המייל (${isolate('Gmail')})`, heTo: `למייל (${isolate('Gmail')})`, en: 'Gmail' },
  drive: { he: `הקבצים ב־${isolate('Google Drive')}`, heTo: `לקבצים ב־${isolate('Google Drive')}`, en: 'Google Drive' },
  birthdays: { he: 'ימי ההולדת', heTo: 'לימי ההולדת', en: 'Birthdays' },
  contacts: { he: 'אנשי הקשר', heTo: 'לאנשי הקשר', en: 'Contacts' },
  sms: { he: `הודעות ה־${isolate('SMS')}`, heTo: `להודעות ה־${isolate('SMS')}`, en: 'SMS messages' },
  calls: { he: 'השיחות בטלפון', heTo: 'לשיחות בטלפון', en: 'Phone calls' },
  notifications: { he: 'ההתראות בטלפון', heTo: 'להתראות בטלפון', en: 'Phone notifications' },
  expenses: { he: 'ההוצאות', heTo: 'להוצאות', en: 'Expenses' },
};

export const consentText = {
  sourceName: (source: ConsentSource, lang: Lang): string => (lang === 'en' ? NAMES[source].en : NAMES[source].he),

  /** The card. The source only: nothing has been read yet. */
  card: (source: ConsentSource, lang: Lang): string =>
    lang === 'en' ? `The smart model asks for access to: ${NAMES[source].en}` : `המודל החכם מבקש גישה ${NAMES[source].heTo}.`,

  buttonOnce: (lang: Lang): string => (lang === 'en' ? 'Allow this time' : 'לאשר הפעם'),
  buttonConversation: (lang: Lang): string => (lang === 'en' ? 'Allow in this chat' : 'לאשר בשיחה הזו'),
  buttonNo: (lang: Lang): string => (lang === 'en' ? 'No' : 'לא'),

  /** A tap on a card that is used, expired, overtaken, or not this sender's. Never says which. */
  expired: (lang: Lang): string => (lang === 'en' ? 'This has expired. Please ask again.' : 'פג תוקף, יש לשאול שוב.'),

  /** The user said no and the model did not answer: code's own words. */
  declined: (source: ConsentSource, lang: Lang): string =>
    lang === 'en' ? `Not allowed: ${NAMES[source].en}. Nothing was read.` : `לא אושרה גישה ${NAMES[source].heTo}. לא נקרא כלום.`,

  /** `/consents` in a local conversation or the shared thread. */
  onlySmart: (lang: Lang): string =>
    lang === 'en' ? 'Access approvals exist only in smart chats.' : 'אישורי גישה קיימים רק בשיחות חכמות.',

  none: (lang: Lang): string =>
    lang === 'en' ? 'Nothing is allowed in this chat.' : 'בשיחה הזו לא אושרה גישה לשום מקור.',

  list: (sources: readonly ConsentSource[], lang: Lang): string =>
    lang === 'en'
      ? ['Allowed in this chat:', ...sources.map((source) => `• ${NAMES[source].en}`), 'A button revokes one.'].join('\n')
      : ['גישות שאושרו בשיחה הזו:', ...sources.map((source) => `• ${NAMES[source].he}`), 'כדי לבטל, יש ללחוץ על הכפתור.'].join('\n'),

  revokeButton: (source: ConsentSource, lang: Lang): string =>
    lang === 'en' ? `Revoke: ${NAMES[source].en}` : `לבטל: ${NAMES[source].he}`,

  revoked: (source: ConsentSource, lang: Lang): string =>
    lang === 'en' ? `Revoked in this chat: ${NAMES[source].en}.` : `הגישה ${NAMES[source].heTo} בוטלה בשיחה הזו.`,

  revokeExpired: (lang: Lang): string =>
    lang === 'en' ? `This has expired. Send ${isolate('/consents')} again.` : `פג תוקף. אפשר לשלוח שוב ${isolate('/consents')}.`,
};

/**
 * The card's buttons: this time, this conversation, no. Mail, SMS, contacts and
 * notifications hold other people's words: this time or no, only.
 */
export function consentButtons(queryId: string, nonce: string, source: ConsentSource, lang: Lang): OutboundButton[] {
  return [
    { id: consentButtonId(queryId, nonce, 'once'), title: consentText.buttonOnce(lang) },
    ...(mayKeepForConversation(source)
      ? [{ id: consentButtonId(queryId, nonce, 'conv'), title: consentText.buttonConversation(lang) }]
      : []),
    { id: consentButtonId(queryId, nonce, 'no'), title: consentText.buttonNo(lang) },
  ];
}
