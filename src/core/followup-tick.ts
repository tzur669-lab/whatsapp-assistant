/**
 * The hourly tick's mail follow-ups (block L, L2, 2026-10-15).
 *
 * For each due follow-up, at most `MAX_FOLLOWUPS_PER_TICK`: read the thread
 * (no state touched), classify it in code, then move the row and queue its
 * notice in one transaction (`FollowUpStore.settle`). `notify` is a
 * synchronous outbox write that runs inside that transaction. Gmail not
 * connected or disconnected → one "could not check" notice a day; any other
 * failure → `attempts + 1`, and at `MAX_FOLLOWUP_ATTEMPTS` the row is
 * reported unsure. Never "nobody replied" on incomplete evidence.
 */
import type { GoogleResult } from '../google/api.js';
import type { ThreadMessage } from '../google/gmail.js';
import type { OutboundButton } from '../channels/types.js';
import { buttonId } from '../confirm/pending.js';
import { followUpText } from '../render/followups.js';
import type { Lang } from '../render/format-time.js';
import { classifyThread } from './followup-check.js';
import { MAX_FOLLOWUP_ATTEMPTS } from '../tools/followup-store.js';
import type { FollowUp, FollowUpStore, SettleTo } from '../tools/followup-store.js';

export type ThreadReader = { thread(id: string): Promise<GoogleResult<ThreadMessage[]>> };

export type FollowUpNotice = { text: string; buttons?: OutboundButton[] };

export async function checkFollowUps(params: {
  principal: string;
  store: FollowUpStore;
  /** Null: the gmail grant is not connected. */
  gmail: ThreadReader | null;
  /** Synchronous outbox write; runs inside the settling transaction. */
  notify: (notice: FollowUpNotice) => void;
  /** The local day, for the once-a-day "could not check". */
  day: string;
  lang?: Lang;
  onError?: (errorCode: string) => void;
}): Promise<{ settled: number }> {
  const lang = params.lang ?? 'he';
  const due = params.store.due(params.principal);
  if (due.length === 0) return { settled: 0 };

  const couldNotCheck = () =>
    params.store.markCouldNotCheck(params.principal, params.day, () =>
      params.notify({ text: followUpText.couldNotCheck(due.length, lang) }),
    );
  if (!params.gmail) {
    couldNotCheck();
    return { settled: 0 };
  }

  let settled = 0;
  const settle = (row: FollowUp, to: SettleTo, notice: ((nonce: string | null) => FollowUpNotice) | null) => {
    if (params.store.settle(row.id, to, notice ? (nonce) => params.notify(notice(nonce)) : null)) settled++;
  };
  const unsure = (row: FollowUp) => settle(row, 'unsure', () => ({ text: followUpText.unsure(row.subject, lang) }));

  for (const row of due) {
    const read = await params.gmail.thread(row.threadId);
    if (!read.ok) {
      params.onError?.(read.error.code);
      if (read.error.code === 'not_connected' || read.error.code === 'disconnected') {
        couldNotCheck();
        break;
      }
      // The thread is gone: the sent mail cannot be placed.
      if (read.error.code === 'not_found') {
        unsure(row);
        continue;
      }
      const attempts = params.store.recordFailure(row.id);
      if (attempts !== null && attempts >= MAX_FOLLOWUP_ATTEMPTS) unsure(row);
      continue;
    }
    switch (classifyThread(read.value, row.sentId, row.sentAt)) {
      case 'answered':
        settle(row, 'answered', null);
        break;
      case 'bounced':
        settle(row, 'bounced', () => ({ text: followUpText.bounced(row.subject, lang) }));
        break;
      case 'maybe_bounced':
        settle(row, 'unsure', () => ({ text: followUpText.maybeBounced(row.subject, lang) }));
        break;
      case 'unsure':
        unsure(row);
        break;
      case 'waiting':
        settle(row, 'notified', (nonce) => ({
          text: followUpText.notified(row.subject, row.dueAt, lang),
          buttons: [
            { id: buttonId('fu', row.id, nonce!, 'ok'), title: followUpText.draftButton(lang) },
            { id: buttonId('fu', row.id, nonce!, 'no'), title: followUpText.dismissButton(lang) },
          ],
        }));
        break;
    }
  }
  return { settled };
}
