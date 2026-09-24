/**
 * Snooze and daily maintenance (PLAN §6.5, §6.7).
 *
 * Snooze rides on the same store as an Undo, because it is the same object: a
 * one-shot, sender-bound, nonce-checked action written down for later. The
 * gates are therefore the ones already proven, and what is tested here is that
 * they are actually applied — that a snooze cannot be replayed, cannot be taken
 * by another sender, and does not outlive its window.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState, createFakeMeta } from '../../integration/fake-do-state.js';
import type { FakeDoState, FakeMeta } from '../../integration/fake-do-state.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, parseButtonId } from '../../../src/confirm/pending.js';
import { UndoActions, SNOOZE_EXPIRY_MS } from '../../../src/confirm/undo.js';
import { Repository } from '../../../src/core/repo.js';
import { hashPrincipal } from '../../../src/security/redact.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { AppEnv } from '../../../src/core/env.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const NOW = Date.parse('2026-09-25T05:00:00Z');
const SELF = '972500000000';

const ENV: AppEnv = {
  ENVIRONMENT: 'test',
  WA_APP_SECRET: 'x',
  WA_VERIFY_TOKEN: 'x',
  WA_ACCESS_TOKEN: 'x',
  ALLOWLIST_WA_IDS: SELF,
  GROQ_API_KEY: '',
  GOOGLE_CLIENT_SECRET: 'x',
  TOKEN_ENC_KEY_V1: Buffer.alloc(32, 3).toString('base64'),
  LOG_HASH_KEY: 'test-key',
  WA_PHONE_NUMBER_ID: 'PNID',
  GOOGLE_CLIENT_ID: 'x',
  PUBLIC_BASE_URL: 'https://assistant.example.test',
};

describe('snooze', () => {
  let fake: FakeDoState;
  let meta: FakeMeta;
  let assistant: AssistantDO;
  let reminders: ReminderStore;
  let repo: Repository;
  let principal: string;

  const plain = (text: string) => stripIsolates(text);

  const tap = (buttonId: string, from = SELF): InboundEvent => ({
    kind: 'button',
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from,
    sentAtMs: Date.now() - 1_000,
    buttonId,
    forwarded: false,
  });

  /** Ring a reminder and hand back the buttons that came with it. */
  const ring = async (text = 'להתקשר לאבא') => {
    reminders.schedule({
      principal,
      text,
      dueAtUtc: Date.now() - 1_000,
      localWallTime: 'x',
      tz: 'Asia/Jerusalem',
    });
    await assistant.alarm();
    return meta.sent.at(-1)!.buttons;
  };

  const deliver = (event: InboundEvent) =>
    assistant.fetch(
      new Request('https://do/do/inbound', { method: 'POST', body: JSON.stringify(event) }),
    );

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    fake = createFakeDoState();
    meta = createFakeMeta();
    assistant = new AssistantDO(fake.state as never, ENV, meta.fetchImpl);
    await Promise.resolve();

    repo = new Repository(fake.driver);
    reminders = new ReminderStore(fake.driver, () => Date.now());
    principal = await hashPrincipal(SELF, ENV.LOG_HASH_KEY);
    repo.touchWindow(principal, NOW - 60_000);
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('reschedules the reminder ten minutes on', async () => {
    const buttons = await ring();
    const snooze10 = buttons.find((b) => parseButtonId(b.id)?.verb === 'm10')!;

    await deliver(tap(snooze10.id));

    const pending = reminders.listUpcoming(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAtUtc).toBe(NOW + 10 * 60_000);
    expect(pending[0]?.text).toBe('להתקשר לאבא');
  });

  it('reschedules an hour on', async () => {
    const buttons = await ring();
    const hour = buttons.find((b) => parseButtonId(b.id)?.verb === 'h1')!;

    await deliver(tap(hour.id));
    expect(reminders.listUpcoming(principal)[0]?.dueAtUtc).toBe(NOW + 60 * 60_000);
  });

  it('echoes the new time, so a mis-tap is visible', async () => {
    const buttons = await ring();
    await deliver(tap(buttons.find((b) => parseButtonId(b.id)?.verb === 'h1')!.id));

    // 08:00 local + 1h.
    expect(plain(meta.sent.at(-1)!.text)).toContain('09:00');
  });

  it('schedules nothing when the reminder is marked done', async () => {
    const buttons = await ring();
    await deliver(tap(buttons.find((b) => parseButtonId(b.id)?.verb === 'done')!.id));

    expect(reminders.listUpcoming(principal)).toHaveLength(0);
  });

  it('works once: a second tap reschedules nothing', async () => {
    const buttons = await ring();
    const snooze10 = buttons.find((b) => parseButtonId(b.id)?.verb === 'm10')!;

    await deliver(tap(snooze10.id));
    await deliver(tap(snooze10.id));

    expect(reminders.listUpcoming(principal)).toHaveLength(1);
  });

  it('cannot be used by another sender', async () => {
    const buttons = await ring();
    await deliver(tap(buttons[0]!.id, '972500000009'));
    expect(reminders.listUpcoming(principal)).toHaveLength(0);
  });

  it('expires, so an old reminder cannot be revived days later', async () => {
    const buttons = await ring();
    vi.setSystemTime(NOW + SNOOZE_EXPIRY_MS + 60_000);
    repo.touchWindow(principal, Date.now() - 60_000);

    await deliver(tap(buttons[0]!.id));
    expect(reminders.listUpcoming(principal)).toHaveLength(0);
  });

  it('re-arms the alarm for the new time', async () => {
    const buttons = await ring();
    await deliver(tap(buttons.find((b) => parseButtonId(b.id)?.verb === 'm10')!.id));

    expect(fake.alarmAt()).toBe(NOW + 10 * 60_000);
  });

  it('can be snoozed again when it rings the second time', async () => {
    const first = await ring();
    await deliver(tap(first.find((b) => parseButtonId(b.id)?.verb === 'm10')!.id));

    vi.setSystemTime(NOW + 11 * 60_000);
    repo.touchWindow(principal, Date.now() - 60_000);
    await assistant.alarm();

    const second = meta.sent.at(-1)!.buttons;
    await deliver(tap(second.find((b) => parseButtonId(b.id)?.verb === 'm10')!.id));
    expect(reminders.listUpcoming(principal)[0]?.dueAtUtc).toBe(NOW + 21 * 60_000);
  });
});

describe('daily maintenance', () => {
  let fake: FakeDoState;
  let assistant: AssistantDO;
  let repo: Repository;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake = createFakeDoState();
    assistant = new AssistantDO(fake.state as never, ENV, createFakeMeta().fetchImpl);
    await Promise.resolve();
    repo = new Repository(fake.driver);
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('purges inbound records past their retention window', async () => {
    repo.recordInbound({
      wamid: 'old',
      principal: 'p',
      receivedAt: NOW - 40 * 24 * 60 * 60 * 1000,
      sentAt: NOW,
      kind: 'text',
    });
    repo.recordInbound({ wamid: 'new', principal: 'p', receivedAt: NOW, sentAt: NOW, kind: 'text' });

    await assistant.runMaintenance();

    expect(repo.getInbound('old')).toBeNull();
    expect(repo.getInbound('new')).not.toBeNull();
  });

  it('expires confirmations and undos that were never answered', async () => {
    const pending = new PendingActions(fake.driver, () => Date.now());
    const deferred = new UndoActions(fake.driver, () => Date.now());
    pending.create({ tool: 't', input: {}, summary: 's', tier: 2, principal: 'p' });
    deferred.offer({ tool: 't', compensating: {}, principal: 'p' });

    vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
    await assistant.runMaintenance();

    expect(fake.driver.exec("SELECT * FROM pending_actions WHERE status = 'pending'")).toEqual([]);
    expect(fake.driver.exec("SELECT * FROM undo_actions WHERE status = 'pending'")).toEqual([]);
  });

  it('clears spent OAuth links and states', async () => {
    fake.driver.exec(
      'INSERT INTO oauth_links (id, principal, created_at, expires_at) VALUES (?, ?, ?, ?)',
      'stale',
      'p',
      NOW - 60 * 60 * 1000,
      NOW - 30 * 60 * 1000,
    );

    await assistant.runMaintenance();
    expect(fake.driver.exec('SELECT * FROM oauth_links')).toEqual([]);
  });

  it('leaves the alarm pointing at the next reminder', async () => {
    new ReminderStore(fake.driver, () => Date.now()).schedule({
      principal: 'p',
      text: 'x',
      dueAtUtc: NOW + 60 * 60 * 1000,
      localWallTime: 'x',
      tz: 'Asia/Jerusalem',
    });

    await assistant.runMaintenance();
    expect(fake.alarmAt()).toBe(NOW + 60 * 60 * 1000);
  });
});
