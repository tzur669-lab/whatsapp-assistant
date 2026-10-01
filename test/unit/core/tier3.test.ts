/**
 * Tier 3, end to end (PLAN §6.4, §6.5, §11.3).
 *
 * Attendees raise an event to Tier 3. Since 2026-10-01 Tier 3 in chat is
 * confirmed like Tier 2 — a confirm button, or the word typed back — and no
 * longer by a typed four-digit code (the user's decision, PLAN §14).
 *
 * What is being pinned: attendees still stop the turn for a confirmation,
 * nothing is written before it, a confirm button, "אישור" and "כן" all run the
 * stored action, a forged button id runs nothing, and cancel cancels.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, parseButtonId, buttonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { GoogleStore } from '../../../src/google/store.js';
import { CalendarClient } from '../../../src/google/calendar.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { statusText } from '../../../src/render/status.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

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
  let questions: OpenQuestions;
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
    questions = new OpenQuestions(driver, () => NOW);

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
      questions,
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

  const withAttendees = [draft('calendar.create_event', { ...MEETING, attendees: ['יוסי'] })];
  const withoutAttendees = [draft('calendar.create_event', MEETING)];

  it('creates a meeting with nobody invited, straight away', async () => {
    const out = await handleInbound(text('תקבע פגישה'), deps(withoutAttendees));
    expect(out.action).toBe('reply');
    if (out.action !== 'reply') return;

    expect(plain(out.text)).toContain('פגישה עם יוסי');
    expect(writes).toHaveLength(1);
  });

  it('stops and asks for a confirmation once someone is named', async () => {
    const out = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');

    expect(plain(out.text)).toContain('משתתפים: יוסי');
    // Nothing was written.
    expect(writes).toHaveLength(0);
  });

  it('offers a confirm and a cancel button, like Tier 2', async () => {
    const out = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');

    expect(out.buttons?.map((b) => parseButtonId(b.id)?.verb)).toEqual(['ok', 'no']);
  });

  it('executes when the confirm button is tapped', async () => {
    const asked = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (asked.action !== 'reply') throw new Error('expected reply');

    const out = await handleInbound(button(asked.buttons![0]!.id), deps(withAttendees));
    if (out.action !== 'reply') throw new Error('expected reply');
    expect(plain(out.text)).toContain('נקבע ביומן');
    expect(writes).toHaveLength(1);
  });

  for (const word of ['אישור', 'כן']) {
    it(`executes when "${word}" is typed back`, async () => {
      await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));

      const out = await handleInbound(text(word), deps(withAttendees));
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('נקבע ביומן');
      expect(writes).toHaveLength(1);
    });
  }

  it('refuses a forged confirm button', async () => {
    await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    const row = driver.exec("SELECT id FROM pending_actions WHERE status = 'pending'")[0];

    await handleInbound(button(buttonId('pa', String(row?.['id']), 'a'.repeat(32), 'ok')), deps(withAttendees));
    expect(writes).toHaveLength(0);
  });

  it('cancels cleanly', async () => {
    const asked = await handleInbound(text('תקבע פגישה עם יוסי'), deps(withAttendees));
    if (asked.action !== 'reply') throw new Error('expected reply');

    const out = await handleInbound(button(asked.buttons![1]!.id), deps(withAttendees));
    expect(out).toMatchObject({ action: 'reply', text: statusText.cancelled });
    expect(writes).toHaveLength(0);
  });
});
