/**
 * One message, end to end (PLAN §6.4, §6.5, §11.3).
 *
 * This is the test that says Phase 4 works: a sentence arrives, code resolves
 * it, policy rules on it, and the right thing happens — or the right question is
 * asked. No network: the parser is a fake, because the real one's daily budget
 * is smaller than this file.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, parseButtonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft, TOMORROW_AT_EIGHT } from '../../integration/fake-nlu.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { statusText } from '../../../src/render/status.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql'].map((file, i) => ({
  id: i + 1,
  sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
}));

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';

const plain = (text: string) => stripIsolates(text);

describe('a turn, end to end', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let pending: PendingActions;
  let deferred: UndoActions;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = (script: unknown[], now = NOW): PipelineDeps => {
    const services: Services = { reminders, pending, deferred, nlu: [createFakeNlu(script)] };
    return { repo, log, now: () => now, principal: PRINCIPAL, services };
  };

  const text = (body: string, overrides: Partial<Record<string, unknown>> = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `wamid.${Math.random().toString(16).slice(2)}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      text: body,
      forwarded: false,
      ...overrides,
    }) as InboundEvent;

  const button = (buttonId: string): InboundEvent => ({
    kind: 'button',
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    buttonId,
    forwarded: false,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    deferred = new UndoActions(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  // -- Tier 1: execute, then offer a way back --------------------------------

  describe('setting a reminder', () => {
    const script = [draft('reminders.create', { text: 'להתקשר לאבא', ...TOMORROW_AT_EIGHT })];

    it('schedules it and echoes the day, date and time', async () => {
      const out = await handleInbound(text('תזכיר לי מחר ב-8 להתקשר לאבא'), deps(script));
      expect(out.action).toBe('reply');
      if (out.action !== 'reply') return;

      expect(plain(out.text)).toContain('יום ו׳ 25.9 · 08:00');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('offers an Undo, because Tier 1 acts before it asks', async () => {
      const out = await handleInbound(text('תזכיר לי'), deps(script));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(out.buttons).toHaveLength(1);
      expect(parseButtonId(out.buttons?.[0]?.id ?? '')?.kind).toBe('undo');
    });

    it('undoes it when the button is tapped', async () => {
      const created = await handleInbound(text('תזכיר לי'), deps(script));
      if (created.action !== 'reply') throw new Error('expected reply');

      const undone = await handleInbound(button(created.buttons![0]!.id), deps(script));
      expect(undone.action).toBe('reply');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('refuses a second tap of the same Undo', async () => {
      const created = await handleInbound(text('תזכיר לי'), deps(script));
      if (created.action !== 'reply') throw new Error('expected reply');
      const id = created.buttons![0]!.id;

      await handleInbound(button(id), deps(script));
      const second = await handleInbound(button(id), deps(script));
      expect(second).toMatchObject({ action: 'reply', text: statusText.confirmNotFound });
    });

    it('asks for the time instead of picking one', async () => {
      const out = await handleInbound(
        text('תזכיר לי מחר להתקשר לאבא'),
        deps([draft('reminders.create', { text: 'להתקשר לאבא', date: { kind: 'relative_days', offset: 1 } })]),
      );
      expect(out).toMatchObject({ action: 'reply', text: 'באיזו שעה?' });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('records the decision in the audit log', async () => {
      await handleInbound(text('תזכיר לי'), deps(script));
      const rows = driver.exec("SELECT * FROM audit_log WHERE tool = 'reminders.create'");
      expect(rows[0]).toMatchObject({ decision: 'ALLOW', tier: 1, outcome: 'ok' });
    });
  });

  // -- Tier 2: write it down, ask, then run the stored row -------------------

  describe('cancelling a reminder', () => {
    const cancelScript = [draft('reminders.cancel', { query_variants: ['אבא'] })];

    const givenAReminder = () =>
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'להתקשר לאבא',
        dueAtUtc: Date.parse('2026-09-25T05:00:00Z'),
        localWallTime: '2026-09-25T08:00',
        tz: 'Asia/Jerusalem',
      });

    it('asks before deleting anything', async () => {
      givenAReminder();
      const out = await handleInbound(text('תבטל את התזכורת לאבא'), deps(cancelScript));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('לאשר?');
      expect(plain(out.text)).toContain('להתקשר לאבא');
      expect(out.buttons).toHaveLength(2);
      // Nothing happened yet.
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('executes the stored row when confirmed', async () => {
      givenAReminder();
      const asked = await handleInbound(text('תבטל'), deps(cancelScript));
      if (asked.action !== 'reply') throw new Error('expected reply');

      const done = await handleInbound(button(asked.buttons![0]!.id), deps(cancelScript));
      expect(done).toMatchObject({ action: 'reply', text: 'התזכורת בוטלה.' });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('does nothing when cancelled', async () => {
      givenAReminder();
      const asked = await handleInbound(text('תבטל'), deps(cancelScript));
      if (asked.action !== 'reply') throw new Error('expected reply');

      const out = await handleInbound(button(asked.buttons![1]!.id), deps(cancelScript));
      expect(out).toMatchObject({ action: 'reply', text: statusText.cancelled });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('refuses a replayed confirmation', async () => {
      givenAReminder();
      const asked = await handleInbound(text('תבטל'), deps(cancelScript));
      if (asked.action !== 'reply') throw new Error('expected reply');
      const id = asked.buttons![0]!.id;

      await handleInbound(button(id), deps(cancelScript));
      const second = await handleInbound(button(id), deps(cancelScript));
      expect(second).toMatchObject({ action: 'reply', text: statusText.confirmNotFound });
    });

    it('refuses a confirmation from another sender', async () => {
      givenAReminder();
      const asked = await handleInbound(text('תבטל'), deps(cancelScript));
      if (asked.action !== 'reply') throw new Error('expected reply');

      const out = await handleInbound(button(asked.buttons![0]!.id), {
        ...deps(cancelScript),
        principal: 'p_someone_else',
      });
      expect(out).toMatchObject({ action: 'reply', text: statusText.confirmNotFound });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('accepts a plain כן when exactly one thing is pending', async () => {
      givenAReminder();
      await handleInbound(text('תבטל'), deps(cancelScript));

      const out = await handleInbound(text('כן'), deps(cancelScript));
      expect(out).toMatchObject({ action: 'reply', text: 'התזכורת בוטלה.' });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('will not guess which question a כן answers when two are open', async () => {
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'א',
        dueAtUtc: Date.parse('2026-09-25T05:00:00Z'),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });
      pending.create({ tool: 'reminders.cancel', input: {}, summary: 's1', tier: 2, principal: PRINCIPAL });
      pending.create({ tool: 'reminders.cancel', input: {}, summary: 's2', tier: 2, principal: PRINCIPAL });

      const out = await handleInbound(text('כן'), deps(cancelScript));
      expect(out).toMatchObject({ action: 'reply', text: statusText.confirmAmbiguous });
    });

    it('asks which one when the description matches several', async () => {
      givenAReminder();
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'להתקשר לאבא שוב',
        dueAtUtc: Date.parse('2026-09-26T05:00:00Z'),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });

      const out = await handleInbound(text('תבטל'), deps(cancelScript));
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('1.');
      expect(plain(out.text)).toContain('2.');
      expect(out.buttons).toBeUndefined();
    });
  });

  // -- policy ----------------------------------------------------------------

  describe('policy', () => {
    const create = [draft('reminders.create', { text: 'בדיקה', ...TOMORROW_AT_EIGHT })];

    it('refuses every write while paused, and says how to undo that', async () => {
      repo.setPaused(true);
      const out = await handleInbound(text('תזכיר לי'), deps(create));
      expect(out).toMatchObject({ action: 'reply', text: statusText.paused });
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('still answers a read while paused', async () => {
      repo.setPaused(true);
      const out = await handleInbound(text('מה התזכורות שלי'), deps([draft('reminders.list', {})]));
      expect(out).toMatchObject({ action: 'reply', text: 'אין תזכורות ממתינות.' });
    });

    it('confirms instead of executing when the message is stale', async () => {
      const out = await handleInbound(
        text('תזכיר לי', { sentAtMs: NOW - 20 * 60_000 }),
        deps(create),
      );
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('לאשר?');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('confirms instead of executing when the message was forwarded', async () => {
      const out = await handleInbound(text('תזכיר לי', { forwarded: true }), deps(create));
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('לאשר?');
    });

    it('confirms a reminder set beyond the horizon', async () => {
      const out = await handleInbound(
        text('תזכיר לי'),
        deps([
          draft('reminders.create', {
            text: 'חידוש דרכון',
            date: { kind: 'absolute', day: 24, month: 9, year: 2028 },
            time: { hour: 10, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
          }),
        ]),
      );
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('לאשר?');
    });
  });

  // -- the parser is a parser -------------------------------------------------

  describe('the LLM boundary', () => {
    it('sends the message, the clock and the tool catalog — and nothing else', async () => {
      const nlu = createFakeNlu([draft('reminders.list', {})]);
      await handleInbound(text('מה יש לי'), {
        repo,
        log,
        now: () => NOW,
        principal: PRINCIPAL,
        services: { reminders, pending, deferred, nlu: [nlu] },
      });

      const input = nlu.inputs[0]!;
      expect(Object.keys(input).sort()).toEqual(['nowLocalIso', 'text', 'tools', 'weekday']);
      expect(input.weekday).toBe('Thursday');
      expect(input.nowLocalIso).toBe('2026-09-24T12:00:00+03:00');
      // No tiers, scopes or limits — the model has no business knowing them.
      expect(JSON.stringify(input.tools)).not.toContain('tier');
      expect(JSON.stringify(input.tools)).not.toContain('rateLimit');
    });

    it('never reaches the parser for a system command', async () => {
      const nlu = createFakeNlu([draft('reminders.list', {})]);
      await handleInbound(text('/help'), {
        repo,
        log,
        now: () => NOW,
        principal: PRINCIPAL,
        services: { reminders, pending, deferred, nlu: [nlu] },
      });
      expect(nlu.inputs).toHaveLength(0);
    });

    it('never reaches the parser for a confirmation', async () => {
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'א',
        dueAtUtc: Date.parse('2026-09-25T05:00:00Z'),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });
      pending.create({ tool: 'reminders.cancel', input: {}, summary: 's', tier: 2, principal: PRINCIPAL });

      const nlu = createFakeNlu([draft('reminders.list', {})]);
      await handleInbound(text('כן'), {
        repo,
        log,
        now: () => NOW,
        principal: PRINCIPAL,
        services: { reminders, pending, deferred, nlu: [nlu] },
      });
      expect(nlu.inputs).toHaveLength(0);
    });

    it('asks again rather than acting when nothing parses', async () => {
      const out = await handleInbound(text('בלה בלה'), deps([{ garbage: true }]));
      expect(out).toMatchObject({ action: 'reply', text: he.notUnderstood });
      expect(repo.counters(Repository.dayKey(NOW)).fallbacks).toBe(1);
    });

    it('treats a request outside the tool list as unsupported', async () => {
      const out = await handleInbound(text('מה מזג האוויר'), deps([draft('unsupported', {})]));
      expect(out).toMatchObject({ action: 'reply', text: he.notUnderstood });
    });
  });

  // -- system commands --------------------------------------------------------

  describe('system commands', () => {
    it('pauses and resumes, and the state survives', async () => {
      const paused = await handleInbound(text('/pause'), deps([]));
      expect(paused).toMatchObject({ action: 'reply', text: statusText.paused });
      expect(repo.isPaused()).toBe(true);

      expect(await handleInbound(text('/pause'), deps([]))).toMatchObject({
        text: statusText.alreadyPaused,
      });

      const resumed = await handleInbound(text('/resume'), deps([]));
      expect(resumed).toMatchObject({ action: 'reply', text: statusText.resumed });
      expect(repo.isPaused()).toBe(false);
    });

    it('reports the real pending count and pause state in /status', async () => {
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'א',
        dueAtUtc: Date.parse('2026-09-25T05:00:00Z'),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });
      repo.setPaused(true);

      const out = await handleInbound(text('/status'), deps([]));
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('תזכורות ממתינות: 1');
      expect(plain(out.text)).toContain('מושהית');
    });

    it('reports the month in /budget', async () => {
      repo.bumpCounter(Repository.monthKey(NOW), 'wa_sent', 12);
      const out = await handleInbound(text('/budget'), deps([]));
      if (out.action !== 'reply') throw new Error('expected reply');
      expect(plain(out.text)).toContain('12/1000');
    });
  });

  // -- voice ------------------------------------------------------------------

  describe('a spoken reminder', () => {
    const script = [draft('reminders.create', { text: 'להתקשר לאבא', ...TOMORROW_AT_EIGHT })];

    const spoken = (confidence: 'high' | 'uncertain') => ({
      ...deps(script),
      transcribe: async () =>
        ({ status: 'ok', text: 'תזכיר לי מחר בשמונה להתקשר לאבא', confidence, language: 'he' }) as const,
    });

    const audio: InboundEvent = {
      kind: 'audio',
      wamid: 'wamid.voice',
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      mediaId: 'M1',
      mimeType: 'audio/ogg',
      voiceNote: true,
      forwarded: false,
    };

    it('acts on a clear recording, and shows what was heard', async () => {
      const out = await handleInbound(audio, spoken('high'));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('שמעתי: תזכיר לי מחר בשמונה להתקשר לאבא');
      expect(plain(out.text)).toContain('יום ו׳ 25.9 · 08:00');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('asks before writing when the transcript was uncertain', async () => {
      const out = await handleInbound(audio, spoken('uncertain'));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('לאשר?');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });
  });
});
