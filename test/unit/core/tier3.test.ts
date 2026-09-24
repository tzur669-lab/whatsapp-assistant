/**
 * Tier 3, end to end (PLAN §6.4, §6.5, §11.3).
 *
 * Tier 3 is the boundary where an action stops being reversible. An invitation
 * reaches someone outside this system, and deleting the event afterwards does
 * not unsend it — so a tap is not enough, and the code has to be typed back.
 *
 * What is being pinned: attendees raise the tier, no confirm button is offered,
 * a forged button id is refused anyway, and a wrong code executes nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, parseButtonId, buttonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { GoogleStore } from '../../../src/google/store.js';
import { CalendarClient } from '../../../src/google/calendar.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { statusText } from '../../../src/render/status.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql', '0004_google.sql'].map(
  (file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }),
);

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';

const MEETING = {
  title: 'פגישה עם יוסי',
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 14, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
  duration_minutes: 60,
};

const plain = (text: string) => stripIsolates(text);

describe('an action that leaves the system', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let pending: PendingActions;
  let services: Services;
  let writes: { method: string; url: string }[];

  const deps = (script: unknown[]): PipelineDeps => ({
    repo,
    log: createFakeLogger(),
    now: () => NOW,
    principal: PRINCIPAL,
    services: { ...services, nlu: [createFakeNlu(script)] },
  });

  const text = (body: string): InboundEvent => ({
    kind: 'text',
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text: body,
    forwarded: false,
  });

  const button = (id: string): InboundEvent => ({
    kind: 'button',
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    buttonId: id,
    forwarded: false,
  });

  beforeEach(async () => {
    writes = [];
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    pending = new PendingActions(driver, () => NOW);

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method !== 'GET') writes.push({ method, url });

      return new Response(
        JSON.stringify(
          method === 'GET'
            ? { items: [] }
            : {
                id: 'ev-new',
                etag: '"v1"',
                summary: MEETING.title,
                start: { dateTime: '2026-09-25T14:00:00+03:00' },
                end: { dateTime: '2026-09-25T15:00:00+03:00' },
              },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const google = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await google.connect({ refreshToken: 'rt', scopes: [] });

    services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending,
      deferred: new UndoActions(driver, () => NOW),
      nlu: [],
      google,
      publicBaseUrl: 'https://assistant.example.test',
      calendar: new CalendarClient({
        store: google,
        clientId: 'id',
        clientSecret: 'secret',
        log: createFakeLogger(),
        now: () => NOW,
        fetchImpl,
      }),
    };
  });
  afterEach(() => driver.close());

  /** The code the user was shown, read back from the stored row. */
  const codeFor = async (): Promise<string> => {
    const { typedCodeFor } = await import('../../../src/confirm/pending.js');
    const row = driver.exec("SELECT nonce_hash FROM pending_actions WHERE status = 'pending'")[0];
    return typedCodeFor(String(row?.['nonce_hash']));
  };

  const withAttendees = [draft('calendar.create_event', { ...MEETING, attendees: ['יוסי'] })];
  const withoutAttendees = [draft('calendar.create_event', MEETING)];

  it('creates a meeting with nobody invited, straight away', async () => {
    const out = await handleInbound(text('תקבע פגישה'), deps(withoutAttendees));
    expect(out.action).toBe('reply');
    if (out.action !== 'reply') return;

    expect(plain(out.text)).toContain('פגישה עם יוסי');
    expect(writes).toHaveLength(1);
  });

  it('stops and asks for a typed code once someone is invited', async () => {
    const out = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');

    expect(plain(out.text)).toContain('אשר ');
    expect(plain(out.text)).toContain('משתתפים: יוסי');
    // Nothing was written.
    expect(writes).toHaveLength(0);
  });

  it('offers no confirm button at all, only a cancel', async () => {
    // A confirm button would be a path around the code.
    const out = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');

    expect(out.buttons).toHaveLength(1);
    expect(parseButtonId(out.buttons![0]!.id)?.verb).toBe('no');
  });

  it('refuses a forged confirm button for a Tier 3 action', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    const row = driver.exec("SELECT id FROM pending_actions WHERE status = 'pending'")[0];

    const out = await handleInbound(
      button(buttonId('pa', String(row?.['id']), 'a'.repeat(32), 'ok')),
      deps(withAttendees),
    );
    expect(out).toMatchObject({ action: 'reply', text: statusText.confirmTypedRequired });
    expect(writes).toHaveLength(0);
  });

  it('executes when the right code is typed back', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    const code = await codeFor();

    const out = await handleInbound(text(`אשר ${code}`), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');
    expect(plain(out.text)).toContain('נקבע ביומן');
    expect(writes).toHaveLength(1);
  });

  it('does nothing for a wrong code', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    const code = await codeFor();
    const wrong = String((Number(code) + 1) % 10_000).padStart(4, '0');

    await handleInbound(text(`אשר ${wrong}`), deps(withAttendees));
    expect(writes).toHaveLength(0);
  });

  it('does not accept a bare כן for a Tier 3 action', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));

    // "כן" resolves to the one pending action, but Tier 3 is not a yes/no
    // question — the code is the whole point.
    const out = await handleInbound(text('כן'), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');
    expect(writes).toHaveLength(0);
    expect(plain(out.text)).not.toContain('נקבע ביומן');
  });

  it('cancels cleanly', async () => {
    const asked = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (asked.action !== 'reply') throw new Error('expected reply');

    const out = await handleInbound(button(asked.buttons![0]!.id), deps(withAttendees));
    expect(out).toMatchObject({ action: 'reply', text: statusText.cancelled });
    expect(writes).toHaveLength(0);
  });

  it('shows four digits, not a guessable count', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    expect(await codeFor()).toMatch(/^\d{4}$/);
  });

  it('gives different actions different codes', async () => {
    const a = pending.create({ tool: 't', input: {}, summary: 's', tier: 3, principal: PRINCIPAL });
    const b = pending.create({ tool: 't', input: {}, summary: 's', tier: 3, principal: PRINCIPAL });
    expect(a.typedCode).not.toBe(b.typedCode);
  });
});
