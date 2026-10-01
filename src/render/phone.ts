/**
 * Phone-action cards in words (PLAN §6.20).
 *
 * The preview is what the user approves, so it is written here, by code, from
 * the validated input — never by the model. Latin runs, times and app names are
 * isolated (§6.3); gender-neutral, dugri register, like the rest of `he.ts`.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatDuration } from './format-time.js';
import type { Lang } from './format-time.js';

export type PhoneQuestion =
  | 'destination'
  | 'app'
  | 'setting'
  | 'state'
  | 'recipient'
  | 'message'
  | 'contact'
  | 'media'
  | 'play_mode';

export type CardInput =
  | { type: 'alarm'; hour: number; minute: number; label?: string | undefined }
  | { type: 'timer'; seconds: number; label?: string | undefined }
  | { type: 'nav'; app: 'waze' | 'maps'; destination?: string | undefined; favorite?: 'home' | 'work' | undefined }
  | { type: 'app'; queries: string[] }
  | {
      type: 'settings';
      setting: 'flashlight' | 'dnd' | 'ringer' | 'wifi' | 'bluetooth';
      state?: 'on' | 'off' | 'silent' | 'vibrate' | 'normal' | undefined;
    }
  | { type: 'message'; channel: 'sms' | 'whatsapp'; queries: string[]; text: string }
  | { type: 'media'; app: 'youtube' | 'youtube_music'; query: string; mode: 'background' | 'fullscreen' };

const pad = (n: number) => String(n).padStart(2, '0');

export function cardPreview(input: CardInput, lang: Lang): string {
  const he = lang === 'he';
  switch (input.type) {
    case 'alarm': {
      const at = isolateLtr(`${pad(input.hour)}:${pad(input.minute)}`);
      const label = input.label ? ` — ${input.label}` : '';
      return he ? `⏰ שעון מעורר ל-${at}${label}` : `⏰ Alarm at ${at}${label}`;
    }

    case 'timer': {
      const minutes = Math.round(input.seconds / 60);
      const length =
        minutes % 60 === 0 ? formatDuration(minutes / 60, 'hour', lang) : formatDuration(minutes, 'minute', lang);
      const label = input.label ? ` — ${input.label}` : '';
      return he ? `⏱ טיימר: ${length}${label}` : `⏱ Timer: ${length}${label}`;
    }

    case 'nav': {
      const app = isolate(input.app === 'waze' ? 'Waze' : 'Google Maps');
      if (input.favorite === 'home') return he ? `🧭 ניווט הביתה ב-${app}` : `🧭 Navigate home with ${app}`;
      if (input.favorite === 'work') return he ? `🧭 ניווט לעבודה ב-${app}` : `🧭 Navigate to work with ${app}`;
      return he ? `🧭 ניווט ב-${app} אל: ${input.destination ?? ''}` : `🧭 Navigate with ${app} to: ${input.destination ?? ''}`;
    }

    case 'app':
      return he ? `📱 פתיחת האפליקציה: ${input.queries[0] ?? ''}` : `📱 Open the app: ${input.queries[0] ?? ''}`;

    case 'settings':
      return settingText(input.setting, input.state, lang);

    case 'media': {
      const music = input.app === 'youtube_music';
      const app = isolate(music ? 'YouTube Music' : 'YouTube');
      const how = he
        ? input.mode === 'background' ? 'ברקע' : 'במסך מלא'
        : input.mode === 'background' ? 'in the background' : 'full screen';
      return `${music ? '🎵' : '▶️'} ${app}: ${input.query} · ${how}`;
    }

    case 'message': {
      const via = isolate(input.channel === 'whatsapp' ? 'WhatsApp' : 'SMS');
      const to = input.queries[0] ?? '';
      return he ? `✉️ הודעת ${via} אל ${to}:\n${input.text}` : `✉️ ${via} message to ${to}:\n${input.text}`;
    }
  }
}

function settingText(
  setting: 'flashlight' | 'dnd' | 'ringer' | 'wifi' | 'bluetooth',
  state: string | undefined,
  lang: Lang,
): string {
  const he = lang === 'he';
  switch (setting) {
    case 'flashlight':
      if (he) return state === 'off' ? '🔦 כיבוי הפנס' : '🔦 הדלקת הפנס';
      return state === 'off' ? '🔦 Flashlight off' : '🔦 Flashlight on';
    case 'dnd':
      if (he) return state === 'off' ? '🔔 כיבוי מצב "נא לא להפריע"' : '🔕 הפעלת מצב "נא לא להפריע"';
      return state === 'off' ? '🔔 Do not disturb off' : '🔕 Do not disturb on';
    case 'ringer': {
      const mode = he
        ? state === 'silent' ? 'שקט' : state === 'vibrate' ? 'רטט' : 'רגיל'
        : state === 'silent' ? 'silent' : state === 'vibrate' ? 'vibrate' : 'normal';
      return he ? `🔈 צלצול: ${mode}` : `🔈 Ringer: ${mode}`;
    }
    case 'wifi':
      return he ? `📶 פתיחת הגדרות ${isolate('Wi-Fi')}` : `📶 Open ${isolate('Wi-Fi')} settings`;
    case 'bluetooth':
      return he ? `📶 פתיחת הגדרות ${isolate('Bluetooth')}` : `📶 Open ${isolate('Bluetooth')} settings`;
  }
}

/** The reply that carries a card. A card that runs on its own needs no instruction. */
export function cardReply(preview: string, autoRun: boolean, type: CardInput['type'], lang: Lang): string {
  if (autoRun) return preview;
  const he = lang === 'he';
  const lines = [preview, ''];
  if (type === 'message') {
    lines.push(
      he
        ? 'ההודעה תיפתח מוכנה, והשליחה עצמה בלחיצה באפליקציה.'
        : 'The message opens ready to go; sending it is a tap in the messaging app.',
    );
  }
  lines.push(he ? 'יש ללחוץ על "ביצוע" כדי להמשיך.' : 'Tap "Run" to go ahead.');
  return lines.join('\n');
}

export function phoneQuestion(what: PhoneQuestion, lang: Lang): string {
  const he = lang === 'he';
  switch (what) {
    case 'destination':
      return he ? 'לאן לנווט?' : 'Where to?';
    case 'app':
      return he ? 'איזו אפליקציה לפתוח?' : 'Which app?';
    case 'setting':
      return he
        ? `מה לשנות? פנס, "נא לא להפריע", צלצול, ${isolate('Wi-Fi')} או ${isolate('Bluetooth')}.`
        : 'Change what? Flashlight, do not disturb, ringer, Wi-Fi or Bluetooth.';
    case 'state':
      return he ? 'להפעיל או לכבות? בצלצול: שקט, רטט או רגיל.' : 'On or off? For the ringer: silent, vibrate or normal.';
    case 'recipient':
      return he ? 'למי לשלוח?' : 'Who to?';
    case 'message':
      return he ? 'מה לכתוב בהודעה?' : 'What should the message say?';
    case 'contact':
      return he ? 'את מי לחפש באנשי הקשר?' : 'Who should I look for in the contacts?';
    case 'media':
      return he ? 'מה להפעיל? שם של שיר, אמן או סרטון.' : 'Play what? A song, an artist or a video.';
    case 'play_mode':
      return he ? 'להפעיל ברקע או במסך מלא?' : 'In the background, or full screen?';
  }
}
