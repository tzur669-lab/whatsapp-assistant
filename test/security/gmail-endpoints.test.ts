/**
 * `gmail.modify` can send mail and can trash it (block L, L5). The grant holds
 * it for archiving only, so the Gmail client may reach exactly these
 * endpoints, and every label it adds or removes is INBOX or one the bot named
 * itself. A new call site fails here until it is a decision.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GmailClient } from '../../src/google/gmail.js';
import { runArchive } from '../../src/core/mail-archive.js';
import { ArchiveStore } from '../../src/tools/archive-store.js';
import { TestSqlDriver } from '../integration/sqlite-driver.js';
import { Repository } from '../../src/core/repo.js';
import { MIGRATIONS } from '../../src/platform/migrations.js';

const GMAIL = readFileSync('src/google/gmail.ts', 'utf8');

/** Every `${BASE}/…` path the client builds, with the variable parts folded. */
const paths = [...GMAIL.matchAll(/`\$\{BASE\}(\/[^`?]*)/g)].map((m) => m[1]!.replace(/\$\{[^}]+\}/g, ':id'));

describe('the Gmail client', () => {
  it('reaches only reading, drafts, labels and batchModify', () => {
    const allowed = new Set(['/messages', '/messages/:id', '/threads/:id', '/drafts', '/labels', '/labels/:id', '/messages/batchModify']);
    expect(paths.filter((path) => !allowed.has(path))).toEqual([]);
  });

  it('has no send, trash, delete-message or import path anywhere in src/', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk('src');
    const banned = /\/(?:messages|drafts|threads)\/(?:send|batchDelete|import|insert)\b|\/(?:messages|threads)\/[^`'"\s]*\/trash\b|\/drafts\/send\b/;
    expect(files.filter((file) => banned.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('an archive only ever adds the batch label and removes INBOX, on exactly the stored ids', async () => {
    const driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    const store = new ArchiveStore(driver, () => Date.now());
    const sent: Array<{ url: string; body: unknown }> = [];
    const gmail = new GmailClient({
      async call(url, init) {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/labels')) return { ok: true, value: { id: 'Label_42' } };
        return { ok: true, value: {} };
      },
    });
    expect(await runArchive({ store, gmail, principal: 'p_me', ids: ['a1', 'b2'] })).toBe('done');
    const modifies = sent.filter((call) => call.url.endsWith('/messages/batchModify')).map((call) => call.body as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] });
    expect(modifies).toEqual([
      { ids: ['a1', 'b2'], addLabelIds: ['Label_42'], removeLabelIds: [] },
      { ids: ['a1', 'b2'], addLabelIds: [], removeLabelIds: ['INBOX'] },
    ]);
    const created = sent.find((call) => call.url.endsWith('/labels'))!.body as { name: string };
    expect(created.name).toMatch(/^בוט\/ארכוב-[0-9a-f]{8}$/);
    driver.close();
  });
});
