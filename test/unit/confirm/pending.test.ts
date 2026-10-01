/**
 * The confirmation system (PLAN §6.5, §11.3). Test-first per CLAUDE.md.
 *
 * Confirmations never go through the LLM. Every check here is deterministic and
 * happens inside the Durable Object, which serializes them — so a double tap
 * cannot execute twice by racing itself.
 *
 * The rule these cases exist to protect: what executes is the *stored* input,
 * never a re-parsed one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PendingActions, buttonId, parseButtonId } from '../../../src/confirm/pending.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';

const INPUT = { text: 'להתקשר לאבא', dueAtUtc: NOW + 3_600_000 };

describe('buttonId', () => {
  it('round-trips', () => {
    const id = buttonId('pa', 'abc123', 'deadbeef', 'ok');
    expect(parseButtonId(id)).toEqual({ kind: 'pa', id: 'abc123', nonce: 'deadbeef', verb: 'ok' });
  });

  it('rejects a non-hex id or nonce, which a real one never is', () => {
    expect(parseButtonId('pa:abc123:nonce456:ok')).toBeNull();
    expect(parseButtonId('pa:../../etc:deadbeef:ok')).toBeNull();
  });

  it('rejects a malformed id rather than guessing', () => {
    expect(parseButtonId('pa:abc')).toBeNull();
    expect(parseButtonId('')).toBeNull();
    expect(parseButtonId('pa:abc:deadbeef:sideways')).toBeNull();
    expect(parseButtonId('evil:abc:deadbeef:ok')).toBeNull();
  });

  it('rejects separators smuggled into a field', () => {
    expect(parseButtonId('pa:ab:cd:ef:ok')).toBeNull();
  });
});

describe('PendingActions', () => {
  let driver: TestSqlDriver;
  let pending: PendingActions;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    pending = new PendingActions(driver, () => now);
  });
  afterEach(() => driver.close());

  const create = () =>
    pending.create({
      tool: 'reminders.cancel',
      input: INPUT,
      summary: 'Cancel a reminder',
      tier: 2,
      principal: SENDER,
    });

  it('stores a pending action and returns a nonce the caller must echo back', () => {
    const action = create();
    expect(action.id).toMatch(/^[0-9a-f]{16,}$/);
    expect(action.nonce).toMatch(/^[0-9a-f]{16,}$/);
    expect(action.status).toBe('pending');
  });

  it('never stores the nonce in the clear', () => {
    const action = create();
    const row = driver.exec('SELECT * FROM pending_actions WHERE id = ?', action.id)[0]!;
    expect(JSON.stringify(row)).not.toContain(action.nonce);
    expect(row['nonce_hash']).toBeTruthy();
  });

  it('confirms once and returns the stored input', () => {
    const action = create();
    const res = pending.confirm(action.id, action.nonce, SENDER);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.action.input).toEqual(INPUT);
  });

  it('refuses a second tap — the classic double-execute', () => {
    const action = create();
    expect(pending.confirm(action.id, action.nonce, SENDER).ok).toBe(true);
    const second = pending.confirm(action.id, action.nonce, SENDER);
    expect(second).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('refuses a wrong nonce', () => {
    const action = create();
    const res = pending.confirm(action.id, 'f'.repeat(32), SENDER);
    expect(res).toEqual({ ok: false, reason: 'bad_nonce' });
  });

  it('refuses a different sender, even with the right nonce', () => {
    const action = create();
    const res = pending.confirm(action.id, action.nonce, OTHER);
    expect(res).toEqual({ ok: false, reason: 'wrong_sender' });
  });

  it('refuses an unknown id', () => {
    expect(pending.confirm('deadbeef', 'nonce', SENDER)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses after the five minute expiry', () => {
    const action = create();
    now = NOW + 5 * 60_000 + 1;
    expect(pending.confirm(action.id, action.nonce, SENDER)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('accepts just inside the expiry', () => {
    const action = create();
    now = NOW + 5 * 60_000 - 1;
    expect(pending.confirm(action.id, action.nonce, SENDER).ok).toBe(true);
  });

  it('refuses when the stored input hash no longer matches', () => {
    const action = create();
    // Simulate the row being tampered with between proposal and confirmation.
    driver.exec('UPDATE pending_actions SET input_json = ? WHERE id = ?', '{"text":"something else"}', action.id);
    expect(pending.confirm(action.id, action.nonce, SENDER)).toEqual({
      ok: false,
      reason: 'input_changed',
    });
  });

  it('cancels without executing', () => {
    const action = create();
    expect(pending.cancel(action.id, action.nonce, SENDER)).toEqual({ ok: true });
    expect(pending.confirm(action.id, action.nonce, SENDER)).toEqual({
      ok: false,
      reason: 'not_pending',
    });
  });

  it('refuses to cancel with a wrong nonce', () => {
    const action = create();
    expect(pending.cancel(action.id, 'wrong', SENDER)).toEqual({ ok: false, reason: 'bad_nonce' });
  });

  it('expires stale rows on sweep', () => {
    const action = create();
    now = NOW + 10 * 60_000;
    pending.expireStale();
    const row = driver.exec('SELECT status FROM pending_actions WHERE id = ?', action.id)[0]!;
    expect(row['status']).toBe('expired');
  });
});

describe('plain-text confirmation', () => {
  let driver: TestSqlDriver;
  let pending: PendingActions;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    pending = new PendingActions(driver, () => NOW);
  });
  afterEach(() => driver.close());

  const create = () =>
    pending.create({ tool: 'reminders.cancel', input: INPUT, summary: 's', tier: 2, principal: SENDER });

  it('accepts a bare "כן" when exactly one action is pending', () => {
    const action = create();
    const res = pending.resolvePlainText('כן', SENDER);
    expect(res).toMatchObject({ ok: true, id: action.id });
  });

  it('accepts the short allowlist in both languages', () => {
    create();
    for (const word of ['כן', 'אשר', 'yes', 'ok', 'OK']) {
      expect(pending.resolvePlainText(word, SENDER).ok).toBe(true);
    }
  });

  it('refuses anything outside the allowlist, however agreeable', () => {
    create();
    for (const word of ['בטח למה לא', 'sure go ahead', 'כן בבקשה תמחק']) {
      expect(pending.resolvePlainText(word, SENDER)).toEqual({ ok: false, reason: 'not_an_answer' });
    }
  });

  it('refuses when two actions are pending — the button has to be tapped', () => {
    create();
    create();
    expect(pending.resolvePlainText('כן', SENDER)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses when nothing is pending', () => {
    expect(pending.resolvePlainText('כן', SENDER)).toEqual({ ok: false, reason: 'nothing_pending' });
  });

  it('ignores another sender’s pending action', () => {
    create();
    expect(pending.resolvePlainText('כן', OTHER)).toEqual({ ok: false, reason: 'nothing_pending' });
  });
});

describe('action cards (PLAN §6.20)', () => {
  let driver: TestSqlDriver;
  let pending: PendingActions;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    pending = new PendingActions(driver, () => NOW);
  });
  afterEach(() => driver.close());

  const card = (tier = 1) =>
    pending.create({ tool: 'alarm.set', input: { hour: 7, minute: 0 }, summary: 'alarm', tier, principal: SENDER, channel: 'card' });

  it('is never confirmed by a plain "כן"', () => {
    card();
    expect(pending.resolvePlainText('כן', SENDER)).toEqual({ ok: false, reason: 'nothing_pending' });
  });

  it('is never confirmed by a typed "אישור", even at Tier 3', () => {
    card(3);
    expect(pending.resolvePlainText('אישור', SENDER)).toEqual({ ok: false, reason: 'nothing_pending' });
  });

  it('does not make a chat confirmation ambiguous', () => {
    card();
    const chat = pending.create({ tool: 'reminders.cancel', input: INPUT, summary: 's', tier: 2, principal: SENDER });
    expect(pending.resolvePlainText('כן', SENDER)).toEqual({ ok: true, id: chat.id });
  });

  it('is not confirmed through the chat button path', () => {
    const action = card();
    expect(pending.confirm(action.id, action.nonce, SENDER)).toEqual({ ok: false, reason: 'not_found' });
    expect(pending.cancel(action.id, action.nonce, SENDER)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('is claimed once, through the card path, with its nonce', () => {
    const action = card();
    expect(pending.confirm(action.id, 'f'.repeat(32), SENDER, 'card')).toEqual({ ok: false, reason: 'bad_nonce' });
    const claimed = pending.confirm(action.id, action.nonce, SENDER, 'card');
    expect(claimed.ok && claimed.action.input).toEqual({ hour: 7, minute: 0 });
    expect(pending.confirm(action.id, action.nonce, SENDER, 'card')).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('can be refused once, through the card path', () => {
    const action = card();
    expect(pending.cancel(action.id, action.nonce, SENDER, 'card')).toEqual({ ok: true });
    expect(pending.confirm(action.id, action.nonce, SENDER, 'card')).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('keeps a chat action out of the card path', () => {
    const chat = pending.create({ tool: 'reminders.cancel', input: INPUT, summary: 's', tier: 2, principal: SENDER });
    expect(pending.confirm(chat.id, chat.nonce, SENDER, 'card')).toEqual({ ok: false, reason: 'not_found' });
  });
});
