/**
 * Two leaks closed on 2026-10-08 (smart conversations, slice 1):
 *
 * - `calendar.move_event` and `calendar.delete_event` answer with event titles —
 *   a confirmation card for one match, a list of choices for several. A title
 *   may be someone else's words (an invitation), so the turn is tainted like
 *   `calendar.list_events`, and the next turn's writes confirm.
 * - A replayed reply reaches the model through `scrubForModel`, like a
 *   read's result: a code-built reply kept in history (a card, a list) may hold
 *   an address, a link or a number.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { TAINTING_TOOLS } from '../../../src/agent/tools.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-10-08, 09:00 local. */
const NOW = Date.parse('2026-10-08T06:00:00Z');
const PRINCIPAL = 'p_scrub';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function event(offsetHours: number, title: string): CalendarEvent {
  const start = NOW + offsetHours * 3_600_000;
  return { id: `evt-${start}`, title, startUtc: start, endUtc: start + 3_600_000, allDay: false, createdByAssistant: false, etag: null };
}

function fakeCalendar(events: CalendarEvent[]): CalendarClient {
  return {
    async listEvents() {
      return { ok: true as const, value: events };
    },
    async listAllEvents() {
      return { ok: true as const, value: events };
    },
  } as unknown as CalendarClient;
}

describe('calendar writes taint, history replay is scrubbed', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let history: ConversationHistory;
  let agent: FakeAgent;

  const deps = (steps: FakeStep[], extra: Partial<Services> = {}): PipelineDeps => {
    agent = createFakeAgent(steps);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: {
        providers: [agent],
        budget: new TokenBudget(() => NOW),
        history,
        lock: new AgentLock(driver, () => NOW),
      },
      ...extra,
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app' };
  };

  let seq = 0;
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.scrub.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
  });
  afterEach(() => driver.close());

  it('move_event and delete_event are tainting tools', () => {
    expect(TAINTING_TOOLS.has('calendar.move_event')).toBe(true);
    expect(TAINTING_TOOLS.has('calendar.delete_event')).toBe(true);
  });

  it('delete_event with several matches: the choices are titles, and history is tainted', async () => {
    const calendar = fakeCalendar([event(3, 'פגישה עם דנה'), event(27, 'פגישה עם דנה ויוסי')]);
    const out = await handleInbound(
      say('תמחק את הפגישה עם דנה מהיומן'),
      deps([{ tool: 'calendar.delete_event', args: { query_variants: ['פגישה עם דנה'] } }], { calendar }),
    );
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.text).toContain('פגישה עם דנה');
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it('delete_event with one match: the card names it, and history is tainted', async () => {
    const calendar = fakeCalendar([event(3, 'ראיון אצל ספק')]);
    await handleInbound(
      say('תמחק את הראיון מהיומן'),
      deps([{ tool: 'calendar.delete_event', args: { query_variants: ['ראיון'] } }], { calendar }),
    );
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it('move_event with several matches: history is tainted', async () => {
    const calendar = fakeCalendar([event(3, 'פגישה עם דנה'), event(27, 'פגישה עם דנה ויוסי')]);
    await handleInbound(
      say('תזיז את הפגישה עם דנה למחר בשמונה בערב ביומן'),
      deps(
        [
          {
            tool: 'calendar.move_event',
            args: {
              query_variants: ['פגישה עם דנה'],
              to_date: { kind: 'relative_days', offset: 1 },
              to_time: { hour: 20, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
            },
          },
        ],
        { calendar },
      ),
    );
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it("a replayed reply reaches the model scrubbed; the user's words, past and present, do not", async () => {
    await history.append(PRINCIPAL, {
      user: 'הוצאתי 25000 על הרכב',
      reply: 'כתוב שם dana@example.com, https://example.com/x ו-0500000000 וקוד 123456',
      tainted: false,
    });
    await handleInbound(say('ומה עם 0501111111?'), deps([{ text: 'בסדר' }]));

    const seen = seenByModel(agent);
    expect(seen).not.toContain('dana@example.com');
    expect(seen).not.toContain('example.com/x');
    expect(seen).not.toContain('0500000000');
    expect(seen).not.toContain('123456');
    expect(seen).toContain('[אימייל]');
    expect(seen).toContain('[קישור]');
    // The user's own words are theirs to send (invariant 2): unchanged.
    expect(seen).toContain('הוצאתי 25000 על הרכב');
    expect(seen).toContain('0501111111');
  });
});
