/**
 * Mail cleanup's three operations (block L, L5, 2026-10-15): the confirmed
 * archive, `/unarchive`, and the temporary label's cleanup. Plain TypeScript:
 * Gmail through `GmailClient`, state through `ArchiveStore`.
 *
 * The archive's order is the safety: the row is written before any call;
 * the batch label is created and added before INBOX is removed; only a
 * definite error from Google (it answered, so nothing changed) is called a
 * failure, an unknown outcome is said to be unknown. `/unarchive` acts on
 * exactly the stored ids that still carry the batch label and are archived.
 * The cleanup never deletes a label it did not name, nor one the user renamed.
 */
import type { GoogleFailure } from '../google/api.js';
import type { GmailClient } from '../google/gmail.js';
import { ARCHIVE_UNDO_MS, CLEANUP_WARN_AFTER, isBotLabel, LABEL_RECONCILE_MS } from '../tools/archive-store.js';
import type { ArchiveStore } from '../tools/archive-store.js';

/** Google answered (or the request was never sent): nothing changed. Anything else may have. */
export function isDefiniteFailure(error: GoogleFailure): boolean {
  switch (error.code) {
    case 'not_connected':
    case 'disconnected':
    case 'not_found':
    case 'changed':
      return true;
    case 'provider_error':
      return error.status >= 400 && error.status < 500;
    case 'network_error':
    case 'invalid_response':
      return false;
  }
}

export type ArchiveOutcome = 'done' | 'failed' | 'unknown';

/** The confirmed archive, steps 1–5 (PLAN §6.36). At most three Gmail calls. */
export async function runArchive(params: { store: ArchiveStore; gmail: GmailClient; principal: string; ids: readonly string[] }): Promise<ArchiveOutcome> {
  const { store, gmail } = params;
  // 1. The row first: from here the batch can always be found again.
  const batch = store.begin(params.principal, params.ids);

  // 2. The batch's own label. Any failure stops here, inbox untouched; an
  //    unknown outcome leaves the label `unknown` for the cleanup to reconcile.
  const created = await gmail.createLabel(batch.labelName);
  if (!created.ok) {
    if (isDefiniteFailure(created.error)) store.labelNotCreated(batch.id);
    store.settle(batch.id, 'failed');
    return 'failed';
  }
  store.labelCreated(batch.id, created.value);

  // 3. The label on exactly the stored ids. A failure stops: still in the inbox.
  const labelled = await gmail.batchModify(params.ids, { add: [created.value] });
  if (!labelled.ok) {
    store.settle(batch.id, 'failed');
    return 'failed';
  }

  // 4. Only now out of the inbox. Unknown or failed: every message carries the
  //    label, so `/unarchive` finds them all; the row stays `pending`.
  const archived = await gmail.batchModify(params.ids, { remove: ['INBOX'] });
  if (!archived.ok) {
    store.settle(batch.id, 'pending');
    return isDefiniteFailure(archived.error) ? 'failed' : 'unknown';
  }

  // 5.
  store.settle(batch.id, 'done');
  return 'done';
}

export type RestoreOutcome =
  | { kind: 'restored'; count: number }
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'running' }
  | { kind: 'already' }
  | { kind: 'not_done' }
  | { kind: 'busy' }
  | { kind: 'label_deleted' }
  | { kind: 'too_many' }
  | { kind: 'failed' };

/** `/unarchive`: the newest batch only, never an older one. */
export async function restoreNewest(params: { store: ArchiveStore; gmail: GmailClient | null; principal: string; nowMs: number }): Promise<RestoreOutcome> {
  const { store } = params;
  const batch = store.newest(params.principal);
  if (!batch) return { kind: 'none' };
  if (batch.createdAt < params.nowMs - ARCHIVE_UNDO_MS) return { kind: 'expired' };
  if (batch.execUntil !== null && batch.execUntil > params.nowMs) return { kind: 'running' };
  if (batch.op === 'restored') return { kind: 'already' };
  if (batch.op === 'failed') return { kind: 'not_done' };
  if (batch.labelId === null) {
    // Died before it had a label: INBOX is removed only after the label, so nothing moved.
    store.failOrphan(batch.id);
    return { kind: 'not_done' };
  }
  if (batch.labelState === 'deleted') return { kind: 'label_deleted' };
  if (!params.gmail) return { kind: 'failed' };
  const gmail = params.gmail;

  const token = store.claimRestore(batch.id);
  if (token === null) return { kind: 'busy' };
  const release = () => store.releaseRestore(batch.id, token);

  // 3. What of this batch is still archived: by the label's id, not its name.
  const listed = await gmail.listIdsBounded('-in:inbox -in:trash -in:spam', 50, [batch.labelId]);
  if (!listed.ok) {
    if (listed.error.code === 'not_found' || (listed.error.code === 'provider_error' && listed.error.status === 400)) {
      const label = await gmail.labelName(batch.labelId);
      if (!label.ok && label.error.code === 'not_found') {
        store.labelGone(batch.id, token);
        return { kind: 'label_deleted' };
      }
    }
    release();
    return { kind: 'failed' };
  }
  if (listed.value.more) {
    release();
    return { kind: 'too_many' };
  }

  // 4. Exactly the stored ids that are still archived; nothing else is ever sent.
  const stored = new Set(batch.ids ?? []);
  const back = listed.value.ids.filter((id) => stored.has(id));
  if (back.length > 0) {
    const restored = await gmail.batchModify(back, { add: ['INBOX'] });
    if (!restored.ok) {
      release();
      return { kind: 'failed' };
    }
  }
  // 5. Under this claim only.
  return store.finishRestore(batch.id, token) ? { kind: 'restored', count: back.length } : { kind: 'busy' };
}

/**
 * The temporary labels' cleanup, at most `MAX_CLEANUPS_PER_TICK` rows. Never
 * gives up silently: a failure backs off up to a day, and the tenth logs once.
 */
export async function cleanArchiveLabels(params: {
  store: ArchiveStore;
  gmail: GmailClient;
  nowMs: number;
  onKept: () => void;
  onFailing: (attempts: number) => void;
}): Promise<number> {
  const { store, gmail } = params;
  let settled = 0;
  for (const batch of store.cleanupDue()) {
    // Only names the bot generated; anything else is left alone, for good.
    if (!isBotLabel(batch.labelName)) {
      store.cleanupResult(batch.id, { kind: 'state', state: 'none' });
      continue;
    }
    if (batch.labelState === 'unknown') {
      const labels = await gmail.listLabels();
      if (!labels.ok) {
        const attempts = store.cleanupResult(batch.id, { kind: 'failed' });
        if (attempts === CLEANUP_WARN_AFTER) params.onFailing(attempts);
        continue;
      }
      const found = labels.value.find((label) => label.name === batch.labelName);
      if (found) store.cleanupResult(batch.id, { kind: 'state', state: 'present', labelId: found.id });
      else if (batch.createdAt < params.nowMs - LABEL_RECONCILE_MS) store.cleanupResult(batch.id, { kind: 'state', state: 'none' });
      else store.cleanupResult(batch.id, { kind: 'wait' });
      settled++;
      continue;
    }
    if (batch.labelId === null) {
      store.cleanupResult(batch.id, { kind: 'state', state: 'none' });
      continue;
    }
    // The name now: a label the user renamed is the user's.
    const current = await gmail.labelName(batch.labelId);
    if (!current.ok && current.error.code === 'not_found') {
      store.cleanupResult(batch.id, { kind: 'state', state: 'deleted' });
      settled++;
      continue;
    }
    if (current.ok && current.value !== batch.labelName) {
      store.markKept(batch.id, params.onKept);
      settled++;
      continue;
    }
    const deleted = current.ok ? await gmail.deleteLabel(batch.labelId) : current;
    if (deleted.ok) {
      store.cleanupResult(batch.id, { kind: 'state', state: 'deleted' });
      settled++;
    } else {
      const attempts = store.cleanupResult(batch.id, { kind: 'failed' });
      if (attempts === CLEANUP_WARN_AFTER) params.onFailing(attempts);
    }
  }
  return settled;
}
