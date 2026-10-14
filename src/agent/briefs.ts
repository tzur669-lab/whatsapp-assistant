/**
 * Brief tool descriptions (block J, J2b, 2026-10-13): what a local turn
 * offered the full catalog sends in place of `llmDescription`, so the full set
 * fits a turn with room to spare. OpenClaw's rule: when space is tight, shorten
 * descriptions before dropping tools.
 *
 * Only the longest descriptions have one. Each keeps the tool's key
 * restriction — what tells it from its neighbour. Slot schemas are unchanged,
 * so every enum, slot and strict check is the same. At most `BRIEF_MAX` chars
 * each (unit test). Never sent to a smart model (`smartFingerprintFor` does
 * not move) or on a narrowed selection, which has room for the full text.
 *
 * Changing one moves the Groq eval fingerprint (`fingerprintFor` hashes the
 * brief catalog): a full `pnpm eval:agent` follows.
 */
import type { ToolName } from '../tools/registry.js';

export const BRIEF_MAX = 80;

export const BRIEFS: Readonly<Partial<Record<ToolName, string>>> = {
  'reminders.repeat': 'Repeating reminder at a stated time: daily, weekdays (0=Sunday) or a month day.',
  'reminders.at_rest': 'Reminder minutes before Shabbat/chag starts (candles) or after it ends.',
  'reminders.scheduled_read': 'Send weather, day times, UV, rates, news or Hebrew date on a schedule.',
  'reminders.leave': 'Reminder to leave for a calendar event (event words, or next_event).',
  'nav.go': "Navigate (Waze/Maps) to a place, a contact's address or a calendar event.",
  'media.play': 'Play music or video on the phone. spotify only if the user said Spotify.',
  'phone.notifications': "Read the phone's notifications from other apps. Not reminders.",
  'info.lookup': 'Public data: weather, Hebrew calendar, rates, news, day times, UV, wikipedia.',
  'tasks.add': 'Add to Google Tasks only when the user says משימות. Named lists: lists.add.',
  'mail.search': "Search or read the user's Gmail, newest first: sender, topic, unread.",
  'mail.draft': 'Write a Gmail draft, a reply or new. Never sent: the user sends it.',
  'drive.search': 'Find Google Drive files by name, kind or recent change.',
  'calc.compute': 'Arithmetic, or units via from_unit/to_unit. Never write a formula.',
  'calendar.free_time': 'Free time in the calendar on a day or range.',
  'notes.save': 'Keep a note with no time ("remember that…"), in the user\'s words.',
  'notes.find': "Show the user's notes (empty query_variants: all). Always call it.",
  'expenses.add': 'Record money spent, in shekels. The day only if said.',
  'expenses.summary': 'How much the user spent in a period, or on one category.',
  'birthdays.upcoming': "Upcoming birthdays, or one person's by name.",
  'mail.bills': 'Bills to pay found in Gmail, with amount and due date.',
  'phone.calls': 'Recent phone calls (names only): who called, missed, with one person.',
  'lists.add': 'Add items to a named list (shopping, ideas). Shares: portfolio.update.',
  'lists.show': 'Show one named list, or all. Always call it, never answer yourself.',
  'memory.remember': 'Fact about the user, asked or said in passing. "תזכור ש…" is notes.save.',
  'portfolio.update': 'A stock the user holds: op set/add/reduce; symbol: ticker (אפל→AAPL).',
  'portfolio.show': "The user's stock portfolio: prices, value, gain. Always call it.",
};
