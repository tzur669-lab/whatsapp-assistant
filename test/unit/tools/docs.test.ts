/**
 * Documents (block L, L6): the card names both destinations; a tainted turn
 * is refused; the Drive create runs once and an uncertain outcome is looked
 * up by its own id and otherwise said to be unknown — never "failed" on a
 * guess, never a second create; the phone gets a Markdown card.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDocText, docFileName, docsCreate, namesDocument } from '../../../src/tools/docs.js';
import { DriveClient, DRIVE_FILE_SCOPE } from '../../../src/google/drive.js';
import type { GoogleResult } from '../../../src/google/api.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { createLogger } from '../../../src/security/redact.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { PendingActions, buttonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { runButton } from '../../../src/core/orchestrator.js';
import { agentToolNames } from '../../../src/agent/tools.js';

const NOW = Date.UTC(2026, 9, 15, 7, 0);

type Call = { url: string; init?: RequestInit };
function drive(answers: Array<GoogleResult<unknown>>, scopes = [DRIVE_FILE_SCOPE]): { client: DriveClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new DriveClient({
    async call(url, init) {
      calls.push({ url, ...(init ? { init } : {}) });
      return answers.shift() ?? { ok: false, error: { code: 'provider_error', status: 500 } };
    },
    grantedScopes: () => scopes,
  });
  return { client, calls };
}

const ctx = (extra: Partial<ToolContext> = {}) =>
  ({ principal: 'p_me', nowMs: NOW, lang: 'he', channel: 'app', log: createLogger(), fileCards: true, ...extra }) as unknown as ToolContext;
const slots = { title: 'רשימת אריזה', body: 'שורה ראשונה\nשורה שנייה\nשורה אחרונה' };

describe('docs.create resolve and card', () => {
  it('both destinations named on the card, with length and first and last lines', () => {
    const { client } = drive([]);
    const ready = docsCreate.resolve(slots, ctx({ drive: client }));
    if (ready.kind !== 'ready') throw new Error('not ready');
    const card = docsCreate.preview(ready.input, 'he');
    expect(card).toContain('יישמר בטלפון');
    expect(card).toContain('Google Drive');
    expect(card).toContain('שורה ראשונה');
    expect(card).toContain('שורה אחרונה');
  });

  it('phone only when Drive lacks drive.file; refused when there is nowhere to save', () => {
    const { client } = drive([], []);
    const ready = docsCreate.resolve(slots, ctx({ drive: client }));
    expect(ready.kind === 'ready' ? (ready.input as { toDrive: boolean }).toDrive : null).toBe(false);
    expect(docsCreate.preview((ready as { input: unknown }).input, 'he')).toContain('בטלפון בלבד');
    expect(docsCreate.resolve(slots, ctx({ fileCards: false })).kind).toBe('clarify');
  });

  it('a tainted turn is refused at resolve and again at execute', async () => {
    expect(docsCreate.resolve(slots, ctx({ tainted: true }))).toMatchObject({ kind: 'clarify', clarify: { what: 'docs_tainted' } });
    const ready = docsCreate.resolve(slots, ctx());
    if (ready.kind !== 'ready') throw new Error('not ready');
    const done = await docsCreate.execute(ready.input, ctx({ tainted: true }));
    expect(done.text).toContain('רק מבקשה');
    expect(done.fileCard).toBeUndefined();
  });

  it('cleans model text: control and bidi characters out, links defanged, capped', () => {
    const cleaned = cleanDocText('a‮b\u0007 https://evil.example/x', 100);
    // eslint-disable-next-line no-control-regex -- the control character is the point
    expect(cleaned).not.toMatch(/[‮\u0007]/);
    expect(cleaned).not.toContain('https://evil.example');
  });

  it('the phone file name has the app\'s shape', () => {
    expect(docFileName('a1b2c3d4e5f60718', NOW)).toMatch(/^[a-z0-9-]{1,48}\.md$/);
  });

  it('namesDocument', () => {
    for (const text of ['תכין לי מסמך השוואה בין הדירות', 'create a document about the trip', 'תשמור את זה בגוגל דוקס']) expect(namesDocument(text), text).toBe(true);
    for (const text of ['מה הקבצים שלי בדרייב', 'תזכיר לי מחר']) expect(namesDocument(text), text).toBe(false);
  });

  it('offered only when named, with Drive or file cards', () => {
    expect(agentToolNames({ cards: true, fileCards: true })).not.toContain('docs.create');
    expect(agentToolNames({ cards: true, fileCards: true, document: true })).toContain('docs.create');
    expect(agentToolNames({ cards: false, document: true, grants: { drive: true } })).toContain('docs.create');
    expect(agentToolNames({ cards: false, document: true })).not.toContain('docs.create');
  });
});

describe('docs.create execute: three Drive outcomes, said exactly', () => {
  const ready = (client: DriveClient) => {
    const outcome = docsCreate.resolve(slots, ctx({ drive: client }));
    if (outcome.kind !== 'ready') throw new Error('not ready');
    return outcome.input;
  };
  const about = { ok: true as const, value: { importFormats: { 'text/markdown': ['application/vnd.google-apps.document'] } } };

  it('created: the link, and a Markdown card for the phone; the upload carries the op and Markdown', async () => {
    const { client, calls } = drive([about, { ok: true, value: { id: 'doc1', webViewLink: 'https://docs.google.com/document/d/doc1/edit' } }]);
    const input = ready(client);
    const done = await docsCreate.execute(input, ctx({ drive: client }));
    expect(done.text).toContain('נוצר ב־');
    expect(done.fileCard).toMatchObject({ mime: 'text/markdown' });
    const upload = calls.find((c) => c.url.includes('/upload/'))!;
    expect(String(upload.init?.body)).toContain(`"op":"${(input as { op: string }).op}"`);
    expect(String(upload.init?.body)).toContain('Content-Type: text/markdown');
    expect(calls.filter((c) => c.url.includes('/upload/'))).toHaveLength(1);
  });

  it('a definite error: failed, no lookup, the phone card still goes', async () => {
    const { client, calls } = drive([about, { ok: false, error: { code: 'provider_error', status: 403 } }]);
    const done = await docsCreate.execute(ready(client), ctx({ drive: client }));
    expect(done.text).toContain('נכשלה');
    expect(done.fileCard).toBeDefined();
    expect(calls.some((c) => c.url.includes('appProperties'))).toBe(false);
  });

  it('a timeout that did create: found by its op, created', async () => {
    const { client, calls } = drive([about, { ok: false, error: { code: 'network_error' } }, { ok: true, value: { files: [{ id: 'doc9', webViewLink: 'https://docs.google.com/document/d/doc9/edit' }] } }]);
    const done = await docsCreate.execute(ready(client), ctx({ drive: client }));
    expect(done.text).toContain('נוצר ב־');
    expect(calls.filter((c) => c.url.includes('/upload/'))).toHaveLength(1);
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain("appProperties has { key='op' and value='");
  });

  it('a timeout, not found (or the lookup fails): unknown, never failed, never a second create', async () => {
    for (const lookup of [{ ok: true as const, value: { files: [] } }, { ok: false as const, error: { code: 'network_error' as const } }]) {
      const { client, calls } = drive([about, { ok: false, error: { code: 'provider_error', status: 503 } }, lookup]);
      const done = await docsCreate.execute(ready(client), ctx({ drive: client }));
      expect(done.text).toContain('לא ברור');
      expect(done.text).not.toContain('נכשלה');
      expect(calls.filter((c) => c.url.includes('/upload/'))).toHaveLength(1);
    }
  });

  it('Markdown not among the import formats: uploaded as plain text', async () => {
    const { client, calls } = drive([{ ok: true, value: { importFormats: {} } }, { ok: true, value: { id: 'd', webViewLink: 'https://docs.google.com/x' } }]);
    await docsCreate.execute(ready(client), ctx({ drive: client }));
    expect(String(calls.find((c) => c.url.includes('/upload/'))!.init?.body)).toContain('Content-Type: text/plain');
  });
});

describe('the phone card after a confirmed document (orchestrator)', () => {
  let driver: TestSqlDriver;
  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it('the confirmed execute returns a file card claimable once', async () => {
    const pending = new PendingActions(driver, () => NOW);
    const tool = { ...ctx({ fileCards: true }), repo: new Repository(driver), reminders: new ReminderStore(driver, () => NOW), lastInboundAt: NOW, monthlySent: 0 } as unknown as ToolContext;
    const turn = { tool, pending, deferred: new UndoActions(driver, () => NOW), messageSentAtMs: NOW, forwarded: false, paused: false, source: 'text' as const };
    const outcome = docsCreate.resolve(slots, tool);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const action = pending.create({ tool: 'docs.create', input: outcome.input, summary: 'doc', tier: 2, principal: 'p_me' });
    const reply = await runButton(buttonId('pa', action.id, action.nonce, 'ok'), turn);
    expect(reply.card).toMatchObject({ type: 'file', autoRun: false });
    const claimed = pending.confirm(reply.card!.actionId, reply.card!.nonce, 'p_me', 'card');
    expect(claimed.ok && (claimed.action.input as { mime: string }).mime).toBe('text/markdown');
    expect(pending.confirm(reply.card!.actionId, reply.card!.nonce, 'p_me', 'card').ok).toBe(false);
  });
});
