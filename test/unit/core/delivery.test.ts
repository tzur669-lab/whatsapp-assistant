/**
 * Outbound tracking and delivery statuses (PLAN §6.8, §11.3).
 *
 * The bug these exist for: `outbound_messages` had been in the schema since
 * migration 0001 and nothing ever wrote to it, while the status webhook was
 * logged and dropped. The Cloud API answers 200 with a valid wamid for messages
 * it never delivers, so a reminder marked `sent` on the strength of that 200
 * alone was the end of the story — nothing would look at it again.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PRINCIPAL = 'p_test00000000';
const WAMID = 'wamid.OUT1';

describe('outbound tracking', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = (): PipelineDeps => ({
    repo,
    log,
    now: () => NOW,
    principal: 'p_system',
    services: {
      reminders,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [],
    },
  });

  const status = (
    overrides: Partial<Extract<InboundEvent, { kind: 'status' }>> = {},
  ): InboundEvent => ({
    kind: 'status',
    wamid: WAMID,
    status: 'delivered',
    sentAtMs: NOW,
    recipient: '972500000000',
    ...overrides,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('records a send as accepted, which is all a 200 actually says', () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW, principal: PRINCIPAL });
    expect(repo.getOutbound(WAMID)?.['delivery_status']).toBe('accepted');
  });

  it('stores no message text, only what it was', () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reminder', sentAt: NOW, principal: PRINCIPAL });
    const row = repo.getOutbound(WAMID);
    expect(Object.values(row ?? {}).join(' ')).not.toContain('להתקשר');
    expect(row?.['kind']).toBe('reminder');
  });

  it('moves the row forward as the statuses arrive', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });

    await handleInbound(status({ status: 'sent' }), deps());
    expect(repo.getOutbound(WAMID)?.['delivery_status']).toBe('sent');

    await handleInbound(status({ status: 'delivered' }), deps());
    expect(repo.getOutbound(WAMID)?.['delivery_status']).toBe('delivered');
  });

  it('never goes backwards, because statuses arrive out of order', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });

    await handleInbound(status({ status: 'read' }), deps());
    await handleInbound(status({ status: 'sent' }), deps());

    expect(repo.getOutbound(WAMID)?.['delivery_status']).toBe('read');
  });

  it('lets a failure win over a late success, which is the truth of it', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });

    await handleInbound(status({ status: 'failed', errorCode: 131026 }), deps());
    await handleInbound(status({ status: 'delivered' }), deps());

    expect(repo.getOutbound(WAMID)?.['delivery_status']).toBe('failed');
    expect(repo.getOutbound(WAMID)?.['error_code']).toBe('E_WA_131026');
  });

  it('never replies to a status, which is Meta talking, not the user', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });
    const out = await handleInbound(status(), deps());
    expect(out.action).toBe('none');
  });

  it('shrugs at a status for a message it has no record of', async () => {
    const out = await handleInbound(status({ wamid: 'wamid.UNKNOWN' }), deps());
    expect(out).toEqual({ action: 'none', reason: 'status' });
  });

  it('records the pricing category when Meta states one', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });
    await handleInbound(status({ status: 'sent', pricingCategory: 'service' }), deps());
    expect(repo.getOutbound(WAMID)?.['pricing_category']).toBe('service');
  });

  it('counts what never arrived, for /status to report', async () => {
    repo.recordOutbound({ wamid: WAMID, kind: 'reply', sentAt: NOW });
    expect(repo.undeliveredSince(NOW - 1000)).toBe(0);

    await handleInbound(status({ status: 'failed', errorCode: 131026 }), deps());
    expect(repo.undeliveredSince(NOW - 1000)).toBe(1);
  });
});

describe('a reminder that Meta accepted and then did not deliver', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = (): PipelineDeps => ({
    repo,
    log,
    now: () => NOW,
    principal: 'p_system',
    services: {
      reminders,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [],
    },
  });

  /** A reminder taken all the way to `sent`, as a delivery leaves it. */
  const sentReminder = (): string => {
    const reminder = reminders.schedule({
      principal: PRINCIPAL,
      text: 'להתקשר לאבא',
      dueAtUtc: NOW - 1_000,
      localWallTime: '2026-09-24 15:00',
      tz: 'Asia/Jerusalem',
    });
    reminders.claimDue();
    reminders.markSent(reminder.id, WAMID);
    repo.recordOutbound({
      wamid: WAMID,
      kind: 'reminder',
      sentAt: NOW,
      principal: PRINCIPAL,
      reminderId: reminder.id,
    });
    return reminder.id;
  };

  const failedStatus = (code: number): InboundEvent => ({
    kind: 'status',
    wamid: WAMID,
    status: 'failed',
    sentAtMs: NOW,
    recipient: '972500000000',
    errorCode: code,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('goes back in the queue when the failure is transient', async () => {
    const id = sentReminder();
    // 130429 is a throughput limit: it will pass.
    const out = await handleInbound(failedStatus(130429), deps());

    expect(reminders.byId(id)?.status).toBe('scheduled');
    // The alarm has to be re-armed, or the requeued row sits there until the
    // next unrelated thing happens to wake the object up.
    expect(out).toEqual({ action: 'none', reason: 'status', rescheduleAlarm: true });
  });

  it('is not retried when the failure will answer the same way every time', async () => {
    const id = sentReminder();
    // 131026 is an undeliverable recipient. Four more tries spend four
    // messages out of a thousand to learn nothing.
    const out = await handleInbound(failedStatus(131026), deps());

    expect(reminders.byId(id)?.status).toBe('failed');
    expect(out).toEqual({ action: 'none', reason: 'status' });

    // Reported once, so the user learns the reminder did not arrive.
    const failed = reminders.takeFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.text).toBe('להתקשר לאבא');
  });

  it('is not retried when the window has shut, which WhatsApp cannot fix', async () => {
    const id = sentReminder();
    await handleInbound(failedStatus(131047), deps());
    expect(reminders.byId(id)?.status).toBe('failed');
    expect(reminders.takeFailed()).toHaveLength(1);
  });

  it('records the failure code where /status can find it', async () => {
    sentReminder();
    await handleInbound(failedStatus(131047), deps());
    expect(repo.lastErrorCode()).toBe('E_WA_131047');
  });

  it('leaves a reminder alone when some other message failed', async () => {
    const id = sentReminder();
    await handleInbound(
      {
        kind: 'status',
        wamid: 'wamid.SOMETHING_ELSE',
        status: 'failed',
        sentAtMs: NOW,
        recipient: '972500000000',
        errorCode: 131026,
      },
      deps(),
    );
    expect(reminders.byId(id)?.status).toBe('sent');
  });
});
