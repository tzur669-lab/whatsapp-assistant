/** `drive.search` (2026-10-01) against a fake Drive API. No network. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { driveSearch } from '../../../src/tools/drive.js';
import { buildDriveQuery, driveValue, DriveClient } from '../../../src/google/drive.js';
import { GoogleApi } from '../../../src/google/api.js';
import { GoogleStore } from '../../../src/google/store.js';
import { GRANTS } from '../../../src/google/grants.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({ id: i + 1, sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8') }));

const NOW = Date.parse('2026-10-01T09:00:00Z');
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('drive.search', () => {
  let driver: TestSqlDriver;
  let ctx: ToolContext;
  let queries: string[];

  beforeEach(async () => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    queries = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }));
      queries.push(url.searchParams.get('q') ?? '');
      expect(url.searchParams.get('fields')).toBe('files(name,mimeType,modifiedTime,owners(displayName))');
      return new Response(
        JSON.stringify({
          files: [
            { name: 'חוזה שכירות 2026', mimeType: 'application/pdf', modifiedTime: '2026-09-20T10:00:00Z', owners: [{ displayName: 'אני' }] },
            { name: 'תקציב', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-30T10:00:00Z' },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }), GRANTS.drive.account);
    await store.connect({ refreshToken: 'rt', scopes: GRANTS.drive.scopes.slice() });
    const log = createFakeLogger();
    ctx = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      log,
      lastInboundAt: NOW,
      monthlySent: 0,
      drive: new DriveClient(new GoogleApi({ store, clientId: 'id', clientSecret: 's', log, now: () => NOW, fetchImpl, label: 'drive' })),
    };
  });
  afterEach(() => driver.close());

  it('builds the query in code, with the quotes taken out of the words', () => {
    expect(driveValue("x' or name contains '")).toBe('x or name contains');
    expect(buildDriveQuery({ words: 'חוזה', kind: 'pdf', days: 30, nowMs: NOW })).toBe(
      "trashed = false and name contains 'חוזה' and mimeType = 'application/pdf' and modifiedTime > '2026-09-01T09:00:00.000Z'",
    );
    expect(buildDriveQuery({ words: null, kind: 'image', days: null, nowMs: NOW })).toBe("trashed = false and mimeType contains 'image/'");
  });

  it('lists names, kinds and dates, and no links', async () => {
    const resolved = driveSearch.resolve({ name: 'חוזה' }, ctx);
    if (resolved.kind !== 'ready') throw new Error('expected ready');
    const text = stripIsolates((await driveSearch.execute(resolved.input, ctx)).text);
    expect(text).toBe('קבצים ב־Drive:\n• חוזה שכירות 2026 — PDF · עודכן יום א׳ 20.9 · אני\n• תקציב — גיליון · עודכן יום ד׳ 30.9');
    expect(text).not.toMatch(/https?:/);
    expect(queries[0]).toBe("trashed = false and name contains 'חוזה'");
  });

  it('says to connect Drive when it is not', async () => {
    const without = { ...ctx };
    delete without.drive;
    expect(stripIsolates((await driveSearch.execute({ query: 'trashed = false' }, without)).text)).toBe(
      'Google Drive לא מחובר. יש לשלוח /connect drive.',
    );
  });
});
