/**
 * The reminder scheduler (PLAN §6.7, §11.5).
 *
 * The property that matters is not "it fires" — it is "it fires exactly once,
 * whatever the platform does". A Durable Object alarm can be re-entered, a
 * deploy can land mid-delivery, and a send can fail after it has already
 * arrived. The claim/lease protocol is the answer, and this file is what proves
 * it holds.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AssistantDO } from '../../../src/platform/assistant-do.js';
import { createFakeDoState, createFakeMeta } from '../../integration/fake-do-state.js';
import type { FakeDoState, FakeMeta } from '../../integration/fake-do-state.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { parseButtonId } from '../../../src/confirm/pending.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { FREE_MESSAGES_PER_MONTH } from '../../../src/policy/window.js';
import type { AppEnv } from '../../../src/core/env.js';

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
  TOKEN_ENC_KEY_V1: 'x',
  LOG_HASH_KEY: 'test-key',
  WA_PHONE_NUMBER_ID: 'PNID',
  GOOGLE_CLIENT_ID: 'x',
  PUBLIC_BASE_URL: 'https://assistant.example.test',
};

describe('the alarm', () => {
  let fake: FakeDoState;
  let meta: FakeMeta;
  let assistant: AssistantDO;
  let reminders: ReminderStore;
  let repo: Repository;
  let principal: string;

  const plain = (text: string) => stripIsolates(text);

  const schedule = (text: string, dueAtUtc: number) =>
    reminders.schedule({ principal, text, dueAtUtc, localWallTime: 'x', tz: 'Asia/Jerusalem' });

  /** The window is open only while the user has written in the last 24 hours. */
  const openTheWindow = (at = NOW - 60_000) => repo.touchWindow(principal, at);

  /**
   * Written straight to the row: `touchWindow` keeps the later of the two
   * timestamps, so it can open a window but never close one.
   */
  const closeTheWindow = () =>
    fake.driver.exec(
      'UPDATE window_state SET last_inbound_at = ? WHERE principal = ?',
      NOW - 40 * 60 * 60_000,
      principal,
    );

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    fake = createFakeDoState();
    meta = createFakeMeta();
    assistant = new AssistantDO(fake.state as never, ENV, meta.fetchImpl);

    // Let the constructor's migration settle before touching storage.
    await Promise.resolve();

    repo = new Repository(fake.driver);
    reminders = new ReminderStore(fake.driver, () => Date.now());
    const { hashPrincipal } = await import('../../../src/security/redact.js');
    principal = await hashPrincipal(SELF, ENV.LOG_HASH_KEY);
    openTheWindow();
  });

  afterEach(() => {
    fake.close();
    vi.useRealTimers();
  });

  it('delivers a reminder that is due', async () => {
    schedule('להתקשר לאבא', NOW - 1_000);
    await assistant.alarm();

    expect(meta.sent).toHaveLength(1);
    expect(plain(meta.sent[0]!.text)).toContain('להתקשר לאבא');
    expect(meta.sent[0]!.to).toBe(SELF);
  });

  it('leaves a reminder that is not due yet alone', async () => {
    schedule('מאוחר יותר', NOW + 60 * 60_000);
    await assistant.alarm();
    expect(meta.sent).toHaveLength(0);
  });

  it('never delivers the same reminder twice, however often the alarm re-enters', async () => {
    schedule('פעם אחת', NOW - 1_000);
    await assistant.alarm();
    await assistant.alarm();
    await assistant.alarm();

    expect(meta.sent).toHaveLength(1);
  });

  it('offers snooze and done alongside the reminder', async () => {
    schedule('להתקשר', NOW - 1_000);
    await assistant.alarm();

    const buttons = meta.sent[0]!.buttons;
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => parseButtonId(b.id)?.verb)).toEqual(['m10', 'h1', 'done']);
  });

  it('says how late a delivery is', async () => {
    schedule('מאוחר', NOW - 15 * 60_000);
    await assistant.alarm();
    expect(plain(meta.sent[0]!.text)).toContain('15');
  });

  it('says nothing about lateness when it is on time', async () => {
    schedule('בזמן', NOW - 1_000);
    await assistant.alarm();
    expect(plain(meta.sent[0]!.text)).not.toContain('באיחור');
  });

  describe('when a send fails', () => {
    it('hands the reminder back rather than losing it', async () => {
      schedule('חשוב', NOW - 1_000);
      meta.failNext(1);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(0);

      // The lease was released, so the next alarm picks it up again.
      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
    });

    it('gives up after five tries and says so once', async () => {
      schedule('נכשל', NOW - 1_000);
      meta.failNext(5);

      for (let i = 0; i < 6; i++) await assistant.alarm();

      // One message: the report that it could not be delivered.
      expect(meta.sent).toHaveLength(1);
      expect(plain(meta.sent[0]!.text)).toContain('נכשל');

      // And it is not reported again.
      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
    });
  });

  describe('a run that dies mid-flight', () => {
    it('lets another alarm take the row once the lease expires', () => {
      schedule('יתום', NOW - 1_000);

      const claimed = reminders.claimDue();
      expect(claimed).toHaveLength(1);

      // A second alarm right away must not take it: the lease is live.
      expect(reminders.claimDue()).toHaveLength(0);

      // Once the lease lapses it is fair game again.
      vi.setSystemTime(NOW + 120_000);
      expect(reminders.claimDue()).toHaveLength(1);
    });
  });

  describe('when nothing can be sent', () => {
    it('holds the reminder when the 24h window is shut, rather than burning an attempt', async () => {
      closeTheWindow(); // last wrote two days ago
      const held = schedule('מוחזק', NOW - 1_000);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(0);

      const row = fake.driver.exec('SELECT * FROM reminders WHERE id = ?', held.id)[0];
      expect(row?.['status']).toBe('scheduled');
      expect(row?.['attempts']).toBe(0);
    });

    it('delivers it late once the user writes back', async () => {
      closeTheWindow();
      schedule('מוחזק', NOW - 1_000);
      await assistant.alarm();
      expect(meta.sent).toHaveLength(0);

      openTheWindow(NOW);
      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
    });

    it('holds it when the monthly budget is gone, which will not fix itself', async () => {
      repo.bumpCounter(Repository.monthKey(NOW), 'wa_sent', FREE_MESSAGES_PER_MONTH);
      schedule('מעל המכסה', NOW - 1_000);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(0);
    });

    it('comes back to look again instead of giving up', async () => {
      closeTheWindow();
      schedule('מוחזק', NOW - 1_000);
      await assistant.alarm();

      expect(fake.alarmAt()).toBeGreaterThan(NOW);
    });
  });

  describe('re-arming', () => {
    it('sets the alarm to the next reminder that is due', async () => {
      schedule('שני', NOW + 2 * 60 * 60_000);
      schedule('ראשון', NOW + 60 * 60_000);

      await assistant.alarm();
      expect(fake.alarmAt()).toBe(NOW + 60 * 60_000);
    });

    it('clears the alarm when nothing is left', async () => {
      schedule('אחרון', NOW - 1_000);
      await assistant.alarm();
      expect(fake.alarmAt()).toBeNull();
    });

    it('never sets an alarm in the past, which would spin', async () => {
      schedule('כבר עבר', NOW - 60 * 60_000);
      const store = new ReminderStore(fake.driver, () => Date.now());
      store.schedule({
        principal,
        text: 'גם עבר',
        dueAtUtc: NOW - 30 * 60_000,
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });
      meta.failNext(2);

      await assistant.alarm();
      const at = fake.alarmAt();
      expect(at === null || at > NOW).toBe(true);
    });
  });

  describe('counting', () => {
    it('counts every delivered message against the monthly budget', async () => {
      schedule('א', NOW - 2_000);
      schedule('ב', NOW - 1_000);
      await assistant.alarm();

      expect(repo.counters(Repository.monthKey(NOW)).waSent).toBe(2);
    });

    it('does not count a send that failed', async () => {
      schedule('א', NOW - 1_000);
      meta.failNext(1);
      await assistant.alarm();

      expect(repo.counters(Repository.monthKey(NOW)).waSent).toBe(0);
    });

    it('records a stable error code when a send fails', async () => {
      schedule('א', NOW - 1_000);
      meta.failNext(1, 401);
      await assistant.alarm();

      expect(repo.lastErrorCode()).toBe('E_WA_SEND_401');
    });
  });

  // -- Shabbat and chagim (PLAN §6.13) ---------------------------------------

  describe('holding over Shabbat', () => {
    /** Saturday 2026-09-26, 12:00 local (09:00 UTC — Israel is on DST). */
    const DURING_SHABBAT = Date.parse('2026-09-26T09:00:00Z');

    it('delivers as normal while the setting is off, which it is by default', async () => {
      vi.setSystemTime(DURING_SHABBAT);
      openTheWindow(DURING_SHABBAT - 60_000);
      schedule('להתקשר לאבא', DURING_SHABBAT - 1_000);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
    });

    it('holds everything once it is on, and re-arms for after Shabbat', async () => {
      repo.setRestHold(true);
      vi.setSystemTime(DURING_SHABBAT);
      openTheWindow(DURING_SHABBAT - 60_000);
      schedule('להתקשר לאבא', DURING_SHABBAT - 1_000);

      await assistant.alarm();

      expect(meta.sent).toHaveLength(0);
      // One decision for the whole period, not one per reminder: the alarm is
      // moved past the end of Shabbat rather than re-checked every few minutes.
      const armed = fake.alarmAt();
      expect(armed).not.toBeNull();
      expect(armed!).toBeGreaterThan(Date.parse('2026-09-26T16:00:00Z'));
    });

    it('delivers it once Shabbat is out', async () => {
      repo.setRestHold(true);
      vi.setSystemTime(DURING_SHABBAT);
      openTheWindow(DURING_SHABBAT - 60_000);
      schedule('להתקשר לאבא', DURING_SHABBAT - 1_000);
      await assistant.alarm();
      expect(meta.sent).toHaveLength(0);

      // Saturday 21:00 local, well after nightfall.
      const motzaeiShabbat = Date.parse('2026-09-26T18:00:00Z');
      vi.setSystemTime(motzaeiShabbat);
      openTheWindow(motzaeiShabbat - 60_000);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
      expect(plain(meta.sent[0]!.text)).toContain('להתקשר לאבא');
    });

    it('does not hold a Friday afternoon, when Shabbat has not started', async () => {
      // Sunset on 2026-09-25 is 18:32, so 15:00 is an ordinary Friday. A fixed
      // "Friday 18:00" rule would have been wrong here half the year.
      repo.setRestHold(true);
      const fridayAfternoon = Date.parse('2026-09-25T12:00:00Z');
      vi.setSystemTime(fridayAfternoon);
      openTheWindow(fridayAfternoon - 60_000);
      schedule('לפני שבת', fridayAfternoon - 1_000);

      await assistant.alarm();
      expect(meta.sent).toHaveLength(1);
    });

    it('holds the digest too, since it is a message like any other', async () => {
      repo.setRestHold(true);
      repo.setDigestHour(12);
      vi.setSystemTime(DURING_SHABBAT);
      openTheWindow(DURING_SHABBAT - 60_000);
      schedule('להתקשר לאבא', DURING_SHABBAT + 3_600_000);

      await assistant.maybeSendDigest();

      expect(meta.sent).toHaveLength(0);
      // Not marked done: a digest held on Shabbat is simply not sent, and
      // tomorrow's is a different day's message.
      expect(repo.digestDoneOn()).toBeNull();
    });
  });
});
