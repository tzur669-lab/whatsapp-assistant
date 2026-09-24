/**
 * One message, end to end (PLAN §6.4, §6.5, §11.3).
 *
 * This is the test that says Phase 4 works: a sentence arrives, code resolves
 * it, policy rules on it, and the right thing happens — or the right question is
 * asked. No network: the parser is a fake, because the real one's daily budget
 * is smaller than this file.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, parseButtonId } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft, TOMORROW_AT_EIGHT } from '../../integration/fake-nlu.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { statusText } from '../../../src/render/status.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
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
  let questions: OpenQuestions;
  /** Movable, so a question can be allowed to expire. */
  let clock = NOW;
  let deferred: UndoActions;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = (script: unknown[], now = NOW): PipelineDeps => {
    const services: Services = { reminders, pending, questions, deferred, nlu: [createFakeNlu(script)] };
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
    clock = NOW;
    questions = new OpenQuestions(driver, () => clock);
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
        services: { reminders, pending, questions, deferred, nlu: [nlu] },
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
        services: { reminders, pending, questions, deferred, nlu: [nlu] },
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
        services: { reminders, pending, questions, deferred, nlu: [nlu] },
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

  // -- the clarification round-trip (PLAN §6.11) -----------------------------
  //
  // The exchange the assistant has more often than any other. Before this, the
  // answer to its own question was parsed with no memory of having asked, so
  // "8" matched no tool and came back "לא הבנתי".

  describe('answering a question it asked', () => {
    /** Tomorrow, with no hour — the draft that provokes "באיזו שעה?". */
    const noTime = [
      draft('reminders.create', {
        text: 'להתקשר לאבא',
        date: { kind: 'relative_days', offset: 1 },
      }),
    ];

    it('asks for the missing hour rather than inventing one', async () => {
      const out = await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('באיזו שעה?');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
      expect(questions.peek(PRINCIPAL)?.asked).toBe('time');
    });

    it('takes a bare "8" as that hour and schedules what was asked about', async () => {
      const nlu = createFakeNlu(noTime);
      const withNlu = (): PipelineDeps => ({
        repo,
        log,
        now: () => NOW,
        principal: PRINCIPAL,
        services: { reminders, pending, questions, deferred, nlu: [nlu] },
      });

      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), withNlu());
      const out = await handleInbound(text('8'), withNlu());
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('יום ו׳ 25.9 · 08:00');

      const [scheduled] = reminders.listUpcoming(PRINCIPAL);
      expect(scheduled?.text).toBe('להתקשר לאבא');

      // The answer never reached the parser: a question code asked is a
      // question code can read, and that is the whole point of §6.11.
      expect(nlu.inputs).toHaveLength(1);
      expect(questions.peek(PRINCIPAL)).toBeNull();
    });

    it('reads "בשמונה בערב" as 20:00, not as eight in the morning', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));
      const out = await handleInbound(text('בשמונה בערב'), deps(noTime));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('יום ו׳ 25.9 · 20:00');
    });

    it('asks again for a part of day, because "בערב" is not an hour (R11)', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));
      const out = await handleInbound(text('בערב'), deps(noTime));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toContain('באיזו שעה בדיוק');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
      // Still open: the user is answering, just not yet with an hour.
      expect(questions.peek(PRINCIPAL)?.asked).toBe('time');
    });

    it('finishes the exchange when the hour finally arrives', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));
      await handleInbound(text('בערב'), deps(noTime));
      await handleInbound(text('8'), deps(noTime));

      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('drops the question on "לא" and writes nothing', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));
      const out = await handleInbound(text('לא'), deps(noTime));
      if (out.action !== 'reply') throw new Error('expected reply');

      expect(plain(out.text)).toBe(plain(statusText.cancelled));
      expect(questions.peek(PRINCIPAL)).toBeNull();
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('treats a fresh request as a fresh request, not as an answer', async () => {
      const nlu = createFakeNlu([
        noTime[0],
        draft('reminders.list', {}),
      ]);
      const withNlu = (): PipelineDeps => ({
        repo,
        log,
        now: () => NOW,
        principal: PRINCIPAL,
        services: { reminders, pending, questions, deferred, nlu: [nlu] },
      });

      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), withNlu());
      await handleInbound(text('מה התזכורות שלי'), withNlu());

      // Parsed from the top, and the stale question is gone rather than
      // waiting to swallow the next message.
      expect(nlu.inputs).toHaveLength(2);
      expect(questions.peek(PRINCIPAL)).toBeNull();
    });

    it('stops being an answer once it has expired', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));

      clock = NOW + 11 * 60 * 1000;
      const later = text('8', { sentAtMs: clock - 1_000 });
      const out = await handleInbound(later, deps(noTime, clock));
      if (out.action !== 'reply') throw new Error('expected reply');

      // Falls through to the parser, which is scripted to repeat the first
      // draft — so the proof is that it asked again instead of scheduling 08:00
      // against a question from a quarter of an hour ago.
      expect(plain(out.text)).toContain('באיזו שעה?');
    });

    it('asks the next question when one answer is not the whole request', async () => {
      // "תזכיר לי מחר" is missing both the body and the hour, so the exchange
      // runs twice. Each answer re-runs the request from the top, which is why
      // the second question is asked at all rather than the first repeated.
      const halfDraft = [draft('reminders.create', { date: { kind: 'relative_days', offset: 1 } })];

      const first = await handleInbound(text('תזכיר לי מחר'), deps(halfDraft));
      if (first.action !== 'reply') throw new Error('expected reply');
      expect(plain(first.text)).toContain('על מה להזכיר?');
      expect(questions.peek(PRINCIPAL)?.asked).toBe('text');

      const second = await handleInbound(text('להתקשר לאבא'), deps(halfDraft));
      if (second.action !== 'reply') throw new Error('expected reply');
      expect(plain(second.text)).toContain('באיזו שעה?');
      expect(questions.peek(PRINCIPAL)?.asked).toBe('time');

      const done = await handleInbound(text('8'), deps(halfDraft));
      if (done.action !== 'reply') throw new Error('expected reply');

      expect(plain(done.text)).toContain('יום ו׳ 25.9 · 08:00');
      expect(reminders.listUpcoming(PRINCIPAL)[0]?.text).toBe('להתקשר לאבא');
      expect(questions.peek(PRINCIPAL)).toBeNull();
    });

    it('never lets an answer confirm a pending action', async () => {
      // A question and a confirmation are different things. "כן" answers the
      // confirmation; it must not be mined for slots by the open question.
      pending.create({
        tool: 'reminders.cancel',
        input: {},
        summary: 's',
        tier: 2,
        principal: PRINCIPAL,
      });
      questions.open({
        principal: PRINCIPAL,
        tool: 'reminders.create',
        slots: { text: 'א' },
        asked: 'time',
        language: 'he',
      });

      const out = await handleInbound(text('כן'), deps(noTime));
      expect(out.action).toBe('reply');
      // The confirmation ran, so the question is still waiting.
      expect(questions.peek(PRINCIPAL)).not.toBeNull();
    });

    it('answers a question asked about a voice note, and still echoes the words', async () => {
      await handleInbound(text('תזכיר לי מחר להתקשר לאבא'), deps(noTime));

      const spokenAnswer = await handleInbound(
        {
          kind: 'audio',
          wamid: 'wamid.answer',
          from: '972500000000',
          sentAtMs: NOW - 1_000,
          mediaId: 'media-1',
          mimeType: 'audio/ogg',
          voiceNote: true,
          forwarded: false,
        },
        {
          ...deps(noTime),
          transcribe: async () => ({
            status: 'ok' as const,
            text: 'בשמונה',
            confidence: 'high' as const,
            language: 'he' as const,
          }),
        },
      );
      if (spokenAnswer.action !== 'reply') throw new Error('expected reply');

      expect(plain(spokenAnswer.text)).toContain('שמעתי: בשמונה');
      expect(plain(spokenAnswer.text)).toContain('יום ו׳ 25.9 · 08:00');
    });
  });
});
