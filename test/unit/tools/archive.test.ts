/**
 * Mail cleanup (block L, L5): the archive's order and outcomes, `/unarchive`
 * (newest batch only, the fence, the lease, exactly the stored ids), and the
 * temporary labels' cleanup — against a fake Gmail that keeps real state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ArchiveStore, ARCHIVE_FENCE_MS, ARCHIVE_UNDO_MS, LABEL_RECONCILE_MS, RESTORE_LEASE_MS } from '../../../src/tools/archive-store.js';
import { cleanArchiveLabels, isDefiniteFailure, restoreNewest, runArchive } from '../../../src/core/mail-archive.js';
import { GmailClient } from '../../../src/google/gmail.js';
import type { GoogleResult } from '../../../src/google/api.js';
import { archiveQuery, GMAIL_MODIFY, mailArchive, namesArchive } from '../../../src/tools/archive.js';
import type { ToolContext } from '../../../src/tools/types.js';

const ME = 'p_me0000000000';
const NOW = Date.UTC(2026, 9, 15, 7, 0);

/** Messages with their labels, and labels by id: enough of Gmail to be wrong in. */
class FakeGmail {
  messages = new Map<string, Set<string>>();
  labels = new Map<string, string>();
  calls: string[] = [];
  /** Per endpoint: answer with this failure instead, once. */
  fail = new Map<string, GoogleResult<unknown>>();
  /** Run before answering an endpoint: a pause point for interleavings. */
  before = new Map<string, () => Promise<void>>();
  scopes = [GMAIL_MODIFY];
  nextLabel = 1;

  constructor(inbox: string[]) {
    for (const id of inbox) this.messages.set(id, new Set(['INBOX']));
  }

  client(): GmailClient {
    return new GmailClient({
      call: (url, init) => this.call(url, init),
      grantedScopes: () => this.scopes,
    });
  }

  private endpoint(url: string, method: string): string {
    const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '').split('?')[0]!;
    if (path === '/labels') return `${method} labels`;
    if (path.startsWith('/labels/')) return `${method} label`;
    if (path === '/messages/batchModify') return 'modify';
    if (path === '/messages') return 'list';
    return path;
  }

  async call(url: string, init?: RequestInit): Promise<GoogleResult<unknown>> {
    const method = init?.method ?? 'GET';
    const key = this.endpoint(url, method);
    this.calls.push(key);
    await this.before.get(key)?.();
    const failure = this.fail.get(key);
    if (failure) {
      this.fail.delete(key);
      return failure;
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    switch (key) {
      case 'POST labels': {
        const id = `Label_${this.nextLabel++}`;
        this.labels.set(id, String(body['name']));
        return { ok: true, value: { id } };
      }
      case 'GET labels':
        return { ok: true, value: { labels: [...this.labels].map(([id, name]) => ({ id, name })) } };
      case 'GET label': {
        const id = decodeURIComponent(url.split('/labels/')[1]!);
        const name = this.labels.get(id);
        return name ? { ok: true, value: { id, name } } : { ok: false, error: { code: 'not_found' } };
      }
      case 'DELETE label': {
        const id = decodeURIComponent(url.split('/labels/')[1]!);
        if (!this.labels.delete(id)) return { ok: false, error: { code: 'not_found' } };
        for (const labels of this.messages.values()) labels.delete(id);
        return { ok: true, value: {} };
      }
      case 'modify': {
        for (const id of body['ids'] as string[]) {
          const labels = this.messages.get(id);
          if (!labels) continue;
          for (const label of body['addLabelIds'] as string[]) labels.add(label);
          for (const label of body['removeLabelIds'] as string[]) labels.delete(label);
        }
        return { ok: true, value: {} };
      }
      case 'list': {
        const query = new URL(url).searchParams;
        const labelIds = query.getAll('labelIds');
        if (labelIds.some((id) => !this.labels.has(id))) return { ok: false, error: { code: 'provider_error', status: 400 } };
        const max = Number(query.get('maxResults'));
        const q = query.get('q') ?? '';
        const matches = [...this.messages].filter(([, labels]) => {
          if (!labelIds.every((id) => labels.has(id))) return false;
          if (q.includes('-in:inbox') && labels.has('INBOX')) return false;
          if (q.includes('-in:trash') && labels.has('TRASH')) return false;
          if (q.includes('-in:spam') && labels.has('SPAM')) return false;
          if (q.startsWith('in:inbox') && !labels.has('INBOX')) return false;
          return true;
        });
        return {
          ok: true,
          value: { messages: matches.slice(0, max).map(([id]) => ({ id })), ...(matches.length > max ? { nextPageToken: 'n' } : {}) },
        };
      }
      default:
        return { ok: false, error: { code: 'provider_error', status: 500 } };
    }
  }

  inInbox(id: string): boolean {
    return this.messages.get(id)?.has('INBOX') ?? false;
  }
}

let driver: TestSqlDriver;
let store: ArchiveStore;
let now = NOW;
beforeEach(() => {
  now = NOW;
  driver = new TestSqlDriver();
  new Repository(driver).migrate(MIGRATIONS);
  store = new ArchiveStore(driver, () => now);
});
afterEach(() => driver.close());

const archive = (gmail: FakeGmail, ids: string[]) => runArchive({ store, gmail: gmail.client(), principal: ME, ids });
const restore = (gmail: FakeGmail | null) => restoreNewest({ store, gmail: gmail?.client() ?? null, principal: ME, nowMs: now });
const row = (id: string) => store.get(id)!;

describe('isDefiniteFailure', () => {
  it('Google answered (4xx, not found) or never sent: definite; network, 5xx, garbage: unknown', () => {
    expect(isDefiniteFailure({ code: 'provider_error', status: 400 })).toBe(true);
    expect(isDefiniteFailure({ code: 'provider_error', status: 429 })).toBe(true);
    expect(isDefiniteFailure({ code: 'disconnected' })).toBe(true);
    expect(isDefiniteFailure({ code: 'provider_error', status: 503 })).toBe(false);
    expect(isDefiniteFailure({ code: 'network_error' })).toBe(false);
    expect(isDefiniteFailure({ code: 'invalid_response' })).toBe(false);
  });
});

describe('runArchive', () => {
  it('done: labelled first, then out of the inbox, three calls; the fence is lifted', async () => {
    const gmail = new FakeGmail(['a', 'b', 'c']);
    expect(await archive(gmail, ['a', 'b'])).toBe('done');
    expect(gmail.calls).toEqual(['POST labels', 'modify', 'modify']);
    expect(gmail.inInbox('a')).toBe(false);
    expect(gmail.inInbox('c')).toBe(true);
    const batch = store.newest(ME)!;
    expect(batch).toMatchObject({ op: 'done', labelState: 'present', execUntil: null });
    expect(gmail.messages.get('a')!.has(batch.labelId!)).toBe(true);
  });

  it('the label create fails definitely: nothing archived, label none', async () => {
    const gmail = new FakeGmail(['a']);
    gmail.fail.set('POST labels', { ok: false, error: { code: 'provider_error', status: 400 } });
    expect(await archive(gmail, ['a'])).toBe('failed');
    expect(gmail.inInbox('a')).toBe(true);
    expect(store.newest(ME)).toMatchObject({ op: 'failed', labelState: 'none' });
  });

  it('the label create times out: nothing archived, the label left unknown for the cleanup', async () => {
    const gmail = new FakeGmail(['a']);
    gmail.fail.set('POST labels', { ok: false, error: { code: 'network_error' } });
    expect(await archive(gmail, ['a'])).toBe('failed');
    expect(gmail.inInbox('a')).toBe(true);
    expect(store.newest(ME)).toMatchObject({ op: 'failed', labelState: 'unknown' });
  });

  it('labelling fails: still in the inbox, failed', async () => {
    const gmail = new FakeGmail(['a']);
    gmail.fail.set('modify', { ok: false, error: { code: 'provider_error', status: 503 } });
    expect(await archive(gmail, ['a'])).toBe('failed');
    expect(gmail.inInbox('a')).toBe(true);
    expect(store.newest(ME)!.op).toBe('failed');
  });

  it('removing INBOX times out: unknown, pending, and /unarchive brings them all back', async () => {
    const gmail = new FakeGmail(['a', 'b']);
    let modifies = 0;
    gmail.before.set('modify', async () => {
      modifies++;
      // The second modify reaches Google and applies, but its answer is lost.
      if (modifies === 2) gmail.fail.set('modify', { ok: false, error: { code: 'network_error' } });
    });
    const original = gmail.call.bind(gmail);
    gmail.call = async (url, init) => {
      const result = await original(url, init);
      return result;
    };
    expect(await archive(gmail, ['a', 'b'])).toBe('unknown');
    expect(store.newest(ME)!.op).toBe('pending');
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: gmail.inInbox('a') ? 0 : 2 });
  });

  it('a crash after the row is written leaves a batch /unarchive answers truthfully', async () => {
    const gmail = new FakeGmail(['a']);
    store.begin(ME, ['a']);
    now += ARCHIVE_FENCE_MS + 1;
    expect(await restore(gmail)).toEqual({ kind: 'not_done' });
    expect(store.newest(ME)!.op).toBe('failed');
    expect(gmail.inInbox('a')).toBe(true);
  });
});

describe('/unarchive (restoreNewest)', () => {
  it('restores exactly the stored ids still archived: not trashed, not spam, not unrelated mail under the label', async () => {
    const gmail = new FakeGmail(['a', 'b', 'c', 'd']);
    await archive(gmail, ['a', 'b', 'c']);
    const labelId = store.newest(ME)!.labelId!;
    gmail.messages.get('b')!.add('TRASH');
    gmail.messages.get('c')!.add('SPAM');
    gmail.messages.set('x', new Set([labelId])); // Someone else's mail under the label.
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 1 });
    expect(gmail.inInbox('a')).toBe(true);
    expect(gmail.inInbox('b')).toBe(false);
    expect(gmail.inInbox('x')).toBe(false);
  });

  it('never moves on to an older batch', async () => {
    const gmail = new FakeGmail(['a1', 'b1']);
    await archive(gmail, ['a1']); // A
    now += 1000;
    await archive(gmail, ['b1']); // B
    expect(await restore(gmail)).toMatchObject({ kind: 'restored' });
    expect(await restore(gmail)).toEqual({ kind: 'already' });
    expect(gmail.inInbox('a1')).toBe(false);
  });

  it('the newest batch failed: nothing, and A is untouched', async () => {
    const gmail = new FakeGmail(['a1', 'b1']);
    await archive(gmail, ['a1']);
    now += 1000;
    gmail.fail.set('POST labels', { ok: false, error: { code: 'provider_error', status: 400 } });
    await archive(gmail, ['b1']);
    expect(await restore(gmail)).toEqual({ kind: 'not_done' });
    expect(gmail.inInbox('a1')).toBe(false);
  });

  it("B restored and its label cleaned: still 'already', A untouched; after 7 days 'expired'", async () => {
    const gmail = new FakeGmail(['a1', 'b1']);
    await archive(gmail, ['a1']);
    now += 1000;
    await archive(gmail, ['b1']);
    await restore(gmail);
    await cleanArchiveLabels({ store, gmail: gmail.client(), nowMs: now, onKept: () => undefined, onFailing: () => undefined });
    expect(store.newest(ME)!.labelState).toBe('deleted');
    expect(await restore(gmail)).toEqual({ kind: 'already' });
    now += ARCHIVE_UNDO_MS + 1;
    store.purge();
    expect(await restore(gmail)).toEqual({ kind: 'expired' });
    expect(gmail.inInbox('a1')).toBe(false);
  });

  it('while an archive is still running: no read, no write', async () => {
    const gmail = new FakeGmail(['a']);
    let release!: () => void;
    gmail.before.set('modify', () => new Promise<void>((resolve) => (release = resolve)));
    const running = archive(gmail, ['a']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBefore = gmail.calls.length;
    expect(await restore(gmail)).toEqual({ kind: 'running' });
    expect(gmail.calls.length).toBe(callsBefore);
    gmail.before.delete('modify');
    release();
    expect(await running).toBe('done');
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 1 });
    expect(gmail.inInbox('a')).toBe(true);
  });

  it('while the label create is in flight: running', async () => {
    const gmail = new FakeGmail(['a']);
    let release!: () => void;
    gmail.before.set('POST labels', () => new Promise<void>((resolve) => (release = resolve)));
    const running = archive(gmail, ['a']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await restore(gmail)).toEqual({ kind: 'running' });
    gmail.before.delete('POST labels');
    release();
    await running;
  });

  it('the user deleted the label: no automatic restore, and op unchanged', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    gmail.labels.clear();
    expect(await restore(gmail)).toEqual({ kind: 'label_deleted' });
    expect(store.newest(ME)).toMatchObject({ op: 'done', labelState: 'deleted' });
    expect(await restore(gmail)).toEqual({ kind: 'label_deleted' });
  });

  it('a renamed label is found by its id', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    const labelId = store.newest(ME)!.labelId!;
    gmail.labels.set(labelId, 'my own name');
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 1 });
  });

  it('two at once: one restores, the other is told it is running; a stale claim writes nothing', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    const id = store.newest(ME)!.id;
    const stale = store.claimRestore(id)!;
    expect(await restore(gmail)).toEqual({ kind: 'busy' });
    now += RESTORE_LEASE_MS + 1;
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 1 });
    expect(store.finishRestore(id, stale)).toBe(false);
  });

  it('a crash after the restore call but before it was recorded: the next /unarchive finishes, nothing twice', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    const id = store.newest(ME)!.id;
    store.claimRestore(id);
    await gmail.client().batchModify(['a'], { add: ['INBOX'] }); // ... and the process died.
    now += RESTORE_LEASE_MS + 1;
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 0 });
    expect(row(id).op).toBe('restored');
  });

  it('a Gmail failure releases the claim for a retry', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    gmail.fail.set('modify', { ok: false, error: { code: 'provider_error', status: 503 } });
    expect(await restore(gmail)).toEqual({ kind: 'failed' });
    expect(await restore(gmail)).toEqual({ kind: 'restored', count: 1 });
  });
});

describe('cleanArchiveLabels', () => {
  const clean = (gmail: FakeGmail, kept: string[] = [], failing: number[] = []) =>
    cleanArchiveLabels({ store, gmail: gmail.client(), nowMs: now, onKept: () => kept.push('kept'), onFailing: (n) => failing.push(n) });

  it('a restored batch: its label deleted; a done one waits until 7 days', async () => {
    const gmail = new FakeGmail(['a', 'b']);
    await archive(gmail, ['a']);
    await clean(gmail);
    expect(gmail.labels.size).toBe(1);
    await restore(gmail);
    await clean(gmail);
    expect(gmail.labels.size).toBe(0);
    expect(store.newest(ME)!.labelState).toBe('deleted');
  });

  it('never while an archive is still fenced', async () => {
    const gmail = new FakeGmail(['a']);
    store.begin(ME, ['a']);
    gmail.labels.set('Label_9', store.newest(ME)!.labelName);
    driver.exec("UPDATE mail_archives SET op = 'failed'");
    await clean(gmail);
    expect(gmail.calls).toEqual([]);
  });

  it('a label the user renamed is kept, with one notice', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    await restore(gmail);
    gmail.labels.set(store.newest(ME)!.labelId!, 'renamed by me');
    const kept: string[] = [];
    await clean(gmail, kept);
    await clean(gmail, kept);
    expect(kept).toHaveLength(1);
    expect(gmail.labels.size).toBe(1);
    expect(store.newest(ME)!.labelState).toBe('kept');
  });

  it('an uncertain create is reconciled by exact name, then deleted; not found waits a day, then none', async () => {
    const gmail = new FakeGmail(['a']);
    gmail.fail.set('POST labels', { ok: false, error: { code: 'network_error' } });
    await archive(gmail, ['a']);
    const name = store.newest(ME)!.labelName;
    gmail.labels.set('Label_late', name); // The create had landed.
    await clean(gmail);
    expect(store.newest(ME)).toMatchObject({ labelState: 'present', labelId: 'Label_late' });
    await clean(gmail);
    expect(gmail.labels.size).toBe(0);

    gmail.fail.set('POST labels', { ok: false, error: { code: 'network_error' } });
    now += 1000;
    await archive(gmail, ['a']);
    await clean(gmail);
    expect(store.newest(ME)!.labelState).toBe('unknown');
    now += LABEL_RECONCILE_MS + 2 * 60 * 60 * 1000;
    await clean(gmail);
    expect(store.newest(ME)!.labelState).toBe('none');
  });

  it('failures back off and never give up silently; a name the bot did not make is never touched', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    await restore(gmail);
    const failing: number[] = [];
    for (let i = 0; i < 12; i++) {
      gmail.fail.set('GET label', { ok: false, error: { code: 'provider_error', status: 503 } });
      await clean(gmail, [], failing);
      now += 25 * 60 * 60 * 1000;
    }
    expect(failing).toEqual([10]);
    expect(store.newest(ME)!.labelState).toBe('present');

    driver.exec("UPDATE mail_archives SET label_name = 'Work/Important'");
    await clean(gmail);
    expect(store.newest(ME)!.labelState).toBe('none');
    expect(gmail.labels.size).toBe(1);
  });

  it('message ids are dropped at 7 days whatever the cleanup state; the row stays until its label is settled', async () => {
    const gmail = new FakeGmail(['a']);
    await archive(gmail, ['a']);
    now += ARCHIVE_UNDO_MS + 1;
    store.purge();
    expect(store.newest(ME)).toMatchObject({ ids: null, labelState: 'present' });
    await clean(gmail);
    store.purge();
    expect(store.newest(ME)).toBeNull();
  });
});

describe('mail.archive (the tool)', () => {
  const ctx = (gmail: FakeGmail) => ({ principal: ME, nowMs: now, lang: 'he', channel: 'app', gmail: gmail.client(), archives: store }) as unknown as ToolContext;

  it('asks to reconnect when the grant lacks gmail.modify', async () => {
    const gmail = new FakeGmail(['a']);
    gmail.scopes = [];
    const outcome = await mailArchive.resolveAsync!({ sender: 'shop' }, ctx(gmail));
    expect(outcome.kind === 'clarify' && outcome.clarify.code === 'personal' ? outcome.clarify.what : null).toBe('archive_reconnect');
  });

  it('needs a filter; 0 matches and more than 50 are questions, never a partial archive', async () => {
    const empty = new FakeGmail([]);
    expect((await mailArchive.resolveAsync!({}, ctx(empty))).kind).toBe('clarify');
    expect(await mailArchive.resolveAsync!({ sender: 'shop' }, ctx(empty))).toMatchObject({ kind: 'clarify', clarify: { what: 'archive_none' } });
    const many = new FakeGmail(Array.from({ length: 51 }, (_, i) => `m${i}`));
    expect(await mailArchive.resolveAsync!({ sender: 'shop' }, ctx(many))).toMatchObject({ kind: 'clarify', clarify: { what: 'archive_too_many' } });
    const fifty = new FakeGmail(Array.from({ length: 50 }, (_, i) => `m${i}`));
    const ready = await mailArchive.resolveAsync!({ sender: 'shop' }, ctx(fifty));
    expect(ready.kind === 'ready' ? (ready.input as { ids: string[] }).ids : []).toHaveLength(50);
  });

  it('the query is code-built, inbox only, words only', () => {
    expect(archiveQuery({ sender: 'shop', about: 'sale', olderThanDays: 14 })).toBe('in:inbox from:(shop) sale older_than:14d');
  });

  it('namesArchive', () => {
    for (const text of ['תארכב את כל המיילים מאמזון', 'לארכב ניוזלטרים', 'archive the newsletters', 'תנקה את תיבת הדואר']) expect(namesArchive(text), text).toBe(true);
    for (const text of ['מה המיילים האחרונים', 'תמחק את התזכורת']) expect(namesArchive(text), text).toBe(false);
  });

  it('the card states the exact count and the label; execute archives exactly the stored ids', async () => {
    const gmail = new FakeGmail(['a', 'b']);
    const ready = await mailArchive.resolveAsync!({ sender: 'shop' }, ctx(gmail));
    if (ready.kind !== 'ready') throw new Error('not ready');
    expect(mailArchive.preview(ready.input, 'he')).toContain('2 מיילים');
    expect(mailArchive.preview(ready.input, 'he')).toContain('תווית זמנית');
    gmail.messages.set('late', new Set(['INBOX'])); // Arrived after the card: not in the stored list.
    const done = await mailArchive.execute(ready.input, ctx(gmail));
    expect(done.text).toContain('ארכבתי 2');
    expect(gmail.inInbox('late')).toBe(true);
  });
});
