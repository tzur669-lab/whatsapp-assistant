/**
 * Scheduled reads (ROADMAP #7, PLAN §6.7): "send me the weather every morning
 * at 7".
 *
 * An occurrence of a recurring reminder that carries a closed action instead of
 * free text. At its due time code runs the lookup and renders the answer — the
 * same `runLookup` that `info.lookup` uses — and the alarm sends it. There is
 * no model anywhere on this path, so there is no loop to bound and nothing a
 * fetched page could talk into an action: news and Hebcal text go only to the
 * user, defanged where they leave like every outbound message.
 *
 * Plain TypeScript: the Durable Object supplies the clock and the collaborators.
 */
import type { Repository } from './repo.js';
import type { ClaimedReminder } from '../tools/reminder-store.js';
import type { ScheduledTopic } from '../nlu/slot-schemas.js';
import { runLookup, unavailable } from '../tools/lookup.js';
import type { Logger } from '../security/redact.js';
import type { Lang } from '../render/format-time.js';
import { reminderText } from '../render/reminders.js';

/**
 * One read may hold the alarm this long. The lease is a minute, and a place
 * lookup plus a forecast can each take eight seconds to time out.
 */
export const SCHEDULED_READ_DEADLINE_MS = 10_000;

/**
 * Later than this, a read is dropped rather than sent. The weather at seven,
 * held over Shabbat, is not worth sending at nightfall; the next occurrence was
 * already written when this one was claimed.
 */
export const SCHEDULED_READ_MAX_LATE_MS = 2 * 60 * 60_000;

export type ScheduledReadDeps = {
  nowMs: number;
  lang: Lang;
  repo: Repository;
  log: Logger;
  fetchImpl: typeof fetch;
};

/** The message to send, or null when the read is too late to be worth it. */
export async function scheduledReadMessage(
  reminder: ClaimedReminder & { action: ScheduledTopic },
  deps: ScheduledReadDeps,
): Promise<string | null> {
  if (reminder.lateByMs > SCHEDULED_READ_MAX_LATE_MS) {
    deps.log.info('scheduled_read_skipped', { reminderId: reminder.id, reason: 'too_late' });
    return null;
  }

  const read = runLookup(
    // Today, at the home city: a schedule has no message to name a place in.
    { topic: reminder.action, dayUtc: deps.nowMs, isToday: true },
    { lang: deps.lang, repo: deps.repo, log: deps.log, fetchImpl: deps.fetchImpl },
  ).then((result) => result.text);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SCHEDULED_READ_DEADLINE_MS);
  });

  // The fetch underneath is not cancelled, only no longer waited for; its
  // answer is dropped with the promise (each request has its own timeout).
  const text = await Promise.race([read.catch(() => null), deadline]);
  clearTimeout(timer);

  if (text === null) deps.log.warn('scheduled_read_failed', { reminderId: reminder.id, topic: reminder.action });
  return `${reminderText.due(reminder.text, deps.lang)}\n\n${text ?? unavailable(deps.lang)}`;
}
