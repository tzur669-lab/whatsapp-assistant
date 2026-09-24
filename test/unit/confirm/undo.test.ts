/**
 * Undo for Tier 1 actions (PLAN §6.5).
 *
 * A Tier 1 tool executes immediately and offers a way back for ten minutes.
 * The checks are the same as a confirmation's, for the same reason: an undo is
 * itself an instruction, and a guessable button must not be able to trigger it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { UndoActions } from '../../../src/confirm/undo.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';

const COMPENSATING = { action: 'delete_reminder', reminderId: 'r_123' };

describe('UndoActions', () => {
  let driver: TestSqlDriver;
  let undo: UndoActions;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    undo = new UndoActions(driver, () => now);
  });
  afterEach(() => driver.close());

  const offer = () =>
    undo.offer({ tool: 'reminders.create', compensating: COMPENSATING, principal: SENDER });

  it('offers an undo and returns a nonce', () => {
    const action = offer();
    expect(action.id).toMatch(/^[0-9a-f]+$/);
    expect(action.nonce).toMatch(/^[0-9a-f]+$/);
  });

  it('never stores the nonce in the clear', () => {
    const action = offer();
    const row = driver.exec('SELECT * FROM undo_actions WHERE id = ?', action.id)[0]!;
    expect(JSON.stringify(row)).not.toContain(action.nonce);
  });

  it('returns the compensating action when used', () => {
    const action = offer();
    const res = undo.use(action.id, action.nonce, SENDER);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.compensating).toEqual(COMPENSATING);
      expect(res.tool).toBe('reminders.create');
    }
  });

  it('can only be used once', () => {
    const action = offer();
    expect(undo.use(action.id, action.nonce, SENDER).ok).toBe(true);
    expect(undo.use(action.id, action.nonce, SENDER)).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('expires after ten minutes', () => {
    const action = offer();
    now = NOW + 10 * 60_000 + 1;
    expect(undo.use(action.id, action.nonce, SENDER)).toEqual({ ok: false, reason: 'expired' });
  });

  it('works just inside the window', () => {
    const action = offer();
    now = NOW + 10 * 60_000 - 1;
    expect(undo.use(action.id, action.nonce, SENDER).ok).toBe(true);
  });

  it('refuses a wrong nonce', () => {
    const action = offer();
    expect(undo.use(action.id, 'deadbeef', SENDER)).toEqual({ ok: false, reason: 'bad_nonce' });
  });

  it('refuses a different sender', () => {
    const action = offer();
    expect(undo.use(action.id, action.nonce, OTHER)).toEqual({ ok: false, reason: 'wrong_sender' });
  });

  it('refuses an unknown id', () => {
    expect(undo.use('00ff00', 'deadbeef', SENDER)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('marks stale offers expired on sweep', () => {
    const action = offer();
    now = NOW + 24 * 60 * 60_000;
    undo.expireStale();
    const row = driver.exec('SELECT status FROM undo_actions WHERE id = ?', action.id)[0]!;
    expect(row['status']).toBe('expired');
  });

  it('keeps several offers independent', () => {
    const first = offer();
    const second = offer();
    expect(undo.use(first.id, first.nonce, SENDER).ok).toBe(true);
    expect(undo.use(second.id, second.nonce, SENDER).ok).toBe(true);
  });

  it('does not accept one offer’s nonce for another', () => {
    const first = offer();
    const second = offer();
    expect(undo.use(second.id, first.nonce, SENDER)).toEqual({ ok: false, reason: 'bad_nonce' });
  });
});
