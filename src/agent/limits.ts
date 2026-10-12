/**
 * The agent turn's time limits (Improvement plan §3 T3). The lock's TTL is
 * derived from them, so no operation of a turn outlives its lock.
 */
import { TIMEOUT_MS as GOOGLE_REQUEST_MS } from '../google/api.js';
import { TOKEN_TIMEOUT_MS } from '../google/oauth.js';

/**
 * No model call or tool starts this long after a turn (or a resume) began.
 * Provisional: chosen far above a normal turn of a few seconds, not measured.
 * The `agent_turn` record is what confirms or raises it.
 */
export const TURN_DEADLINE_MS = 60_000;

/**
 * The longest one `GoogleApi.call` can take (`google/api.ts` `call`): a token
 * refresh, the request, and on a 401 a forced refresh and the retry.
 */
export const GOOGLE_CALL_MAX_MS = 2 * (TOKEN_TIMEOUT_MS + GOOGLE_REQUEST_MS);

/**
 * The longest write a turn can start just before its deadline. A write is the
 * turn's last step (invariant 10) and never sees the deadline: it finishes.
 *
 * The Tier 0–1 executes that write over the network, by sequential
 * `GoogleApi.call`s (Tier 2–3 run later through confirm, outside the lock;
 * every other Tier 1 write is SQLite, or a card in the reply):
 * - `tasks.add` (`tools/tasks.ts` execute): `lists`, `createList` for a list
 *   not there yet, `add` — 3 calls. The largest.
 * - `reminders.create` and the other writes through `scheduleOne`
 *   (`tools/reminders.ts` `writeBackupEvent`, the WhatsApp calendar channel):
 *   `remindersCalendarId` the first time, then `createEvent` — 2 calls.
 * - `calendar.create_event` (`tools/calendar-write.ts` execute): 1 call.
 * - `tasks.complete` (`tools/tasks.ts` execute): `setDone` — 1 call.
 *
 * A write tool's network read in `resolveAsync` (`reminders.leave`, `nav.go`)
 * runs before `execute`, and is bounded by the deadline only once the turn's
 * abort signal reaches it (T3-4).
 */
export const MAX_WRITE_CALLS = 3;
export const MAX_WRITE_MS = MAX_WRITE_CALLS * GOOGLE_CALL_MAX_MS;

/** Settling the turn (one DB update, one history encryption) and clock granularity. */
export const LOCK_MARGIN_MS = 40_000;

/** `TURN_DEADLINE_MS + MAX_WRITE_MS + LOCK_MARGIN_MS`: today 60 + 120 + 40 s. */
export const LOCK_TTL_MS = TURN_DEADLINE_MS + MAX_WRITE_MS + LOCK_MARGIN_MS;
