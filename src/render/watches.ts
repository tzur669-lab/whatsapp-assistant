/**
 * Event-triggered reminders' replies (block J, J4, PLAN §6.30). Every string
 * here holds only the watch's own words (the user's), dates code computed, and
 * fixed text: a creation reply never names a found mail or notification.
 */
import { isolate } from './bidi.js';
import { formatDay } from './format-time.js';
import type { Lang } from './format-time.js';
import { localPartsOf } from '../time/tz.js';
import type { Watch, WatchSource } from '../tools/watch-store.js';

const ZONE = 'Asia/Jerusalem';

const SOURCE: Record<WatchSource, { he: string; en: string }> = {
  mail: { he: 'מייל', en: 'an email' },
  notification: { he: 'התראה בטלפון', en: 'a phone notification' },
  sms: { he: 'הודעת SMS', en: 'an SMS' },
};

const words = (said: readonly string[]) => said.map((word) => isolate(word)).join(', ');
const until = (ms: number, lang: Lang) => formatDay(localPartsOf(ms, ZONE), lang);

export const watchText = {
  created(watch: Pick<Watch, 'source' | 'said' | 'sender' | 'text' | 'expiresAt' | 'firesLeft'>, lang: Lang): string {
    const he = lang === 'he';
    const from = watch.sender ? (he ? ` מ${isolate(watch.sender)}` : ` from ${isolate(watch.sender)}`) : '';
    const again = watch.firesLeft > 1 ? (he ? ' (עד 5 פעמים, שעה בין פעם לפעם)' : ' (up to 5 times, an hour apart)') : '';
    return he
      ? `👀 כשיגיע ${SOURCE[watch.source].he}${from} עם המילים ${words(watch.said)}, אזכיר: ${isolate(watch.text)}${again}\nבתוקף עד ${until(watch.expiresAt, lang)}.`
      : `👀 When ${SOURCE[watch.source].en}${from} with the words ${words(watch.said)} arrives, I'll remind you: ${isolate(watch.text)}${again}\nActive until ${until(watch.expiresAt, lang)}.`;
  },

  cancelled(lang: Lang): string {
    return lang === 'he' ? 'המעקב בוטל.' : 'The watch is cancelled.';
  },

  none(lang: Lang): string {
    return lang === 'he' ? 'אין מעקבים פעילים.' : 'No active watches.';
  },

  list(watches: readonly Watch[], lang: Lang): string {
    const he = lang === 'he';
    const lines = watches.map((watch, index) => {
      const from = watch.sender ? (he ? ` מ${isolate(watch.sender)}` : ` from ${isolate(watch.sender)}`) : '';
      return he
        ? `${index + 1}. ${SOURCE[watch.source].he}${from}: ${words(watch.said)} ← ${isolate(watch.text)} (עד ${until(watch.expiresAt, lang)})`
        : `${index + 1}. ${SOURCE[watch.source].en}${from}: ${words(watch.said)} → ${isolate(watch.text)} (until ${until(watch.expiresAt, lang)})`;
    });
    return `${he ? 'מעקבים פעילים:' : 'Active watches:'}\n${lines.join('\n')}`;
  },

  cancelButton(index: number, lang: Lang): string {
    return lang === 'he' ? `ביטול ${index}` : `Cancel ${index}`;
  },
};
