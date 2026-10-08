import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const MIGRATIONS = [
  { id: 1, sql: readFileSync(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8') },
];

/** `recordInbound` numbers messages in arrival order: 0022 adds the column (§6.23). */
const WITH_SEQ = [
  ...MIGRATIONS,
  { id: 22, sql: readFileSync(new URL('../../../migrations/0022_misses.sql', import.meta.url), 'utf8') },
];

/** A conversation's mode, recorded with its first message (smart conversations, 0026). */
const WITH_MODES = [
  ...WITH_SEQ,
  { id: 26, sql: readFileSync(new URL('../../../migrations/0026_smart_conversations.sql', import.meta.url), 'utf8') },
];

const PRINCIPAL = 'p_000000000000';

describe('Repository.migrate', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
  });
  afterEach(() => driver.close());

  it('applies migrations and records the schema version', () => {
    expect(repo.schemaVersion()).toBe(0);
    expect(repo.migrate(MIGRATIONS)).toBe(1);
    expect(repo.schemaVersion()).toBe(1);
  });

  it('is idempotent across restarts', () => {
    repo.migrate(MIGRATIONS);
    expect(() => repo.migrate(MIGRATIONS)).not.toThrow();
    expect(repo.schemaVersion()).toBe(1);
  });

  it('creates every Phase 1 table', () => {
    repo.migrate(MIGRATIONS);
    const names = driver
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r['name']);
    for (const table of [
      'settings',
      'inbound_messages',
      'outbound_messages',
      'audit_log',
      'counters',
      'window_state',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('stores no column that could hold message text', () => {
    repo.migrate(MIGRATIONS);
    const cols = driver.exec("PRAGMA table_info('inbound_messages')").map((r) => r['name']);
    expect(cols).not.toContain('body');
    expect(cols).not.toContain('text');
  });
});

describe('Repository dedupe and window state', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(WITH_SEQ);
  });
  afterEach(() => driver.close());

  const record = (wamid: string, receivedAt = 1_000) => ({
    wamid,
    principal: PRINCIPAL,
    receivedAt,
    sentAt: receivedAt - 500,
    kind: 'text',
  });

  it('accepts a wamid once', () => {
    expect(repo.recordInbound(record('wamid.A'))).toEqual({ status: 'fresh', mode: 'local' });
  });

  it('rejects a replayed wamid', () => {
    repo.recordInbound(record('wamid.A'));
    expect(repo.recordInbound(record('wamid.A'))).toEqual({ status: 'duplicate' });
  });

  it('keeps the first record when a duplicate arrives', () => {
    repo.recordInbound(record('wamid.A', 1_000));
    repo.recordInbound(record('wamid.A', 9_999));
    expect(repo.getInbound('wamid.A')).toMatchObject({ received_at: 1_000 });
  });

  it('records an outcome without touching identity fields', () => {
    repo.recordInbound(record('wamid.A'));
    repo.markInboundOutcome('wamid.A', { intent: 'reminders.create', decision: 'ALLOW' });
    expect(repo.getInbound('wamid.A')).toMatchObject({
      intent: 'reminders.create',
      decision: 'ALLOW',
      principal: PRINCIPAL,
    });
  });

  it('purges records past the retention cutoff and keeps newer ones', () => {
    repo.recordInbound(record('wamid.OLD', 1_000));
    repo.recordInbound(record('wamid.NEW', 5_000));
    repo.purgeInboundBefore(2_000);
    expect(repo.getInbound('wamid.OLD')).toBeNull();
    expect(repo.getInbound('wamid.NEW')).not.toBeNull();
  });

  it('tracks the 24h window open time and never moves it backwards', () => {
    repo.touchWindow(PRINCIPAL, 5_000);
    repo.touchWindow(PRINCIPAL, 1_000);
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(5_000);
    repo.touchWindow(PRINCIPAL, 9_000);
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(9_000);
  });

  it('returns null for an unknown principal', () => {
    expect(repo.lastInboundAt('p_unknown')).toBeNull();
  });

  it('appends audit entries', () => {
    repo.audit({ ts: 1, principal: PRINCIPAL, decision: 'DENY', outcome: 'not_allowed' });
    const rows = driver.exec('SELECT * FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'DENY', outcome: 'not_allowed' });
  });
});

describe("a conversation's mode (smart conversations)", () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const OTHER = 'p_111111111111';

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(WITH_MODES);
  });
  afterEach(() => driver.close());

  const inbound = (
    wamid: string,
    fields: { conversation?: string; mode?: 'smart' | 'local'; at?: number; principal?: string; kind?: string } = {},
  ) =>
    repo.recordInbound({
      wamid,
      principal: fields.principal ?? PRINCIPAL,
      receivedAt: fields.at ?? 1_000,
      sentAt: (fields.at ?? 1_000) - 500,
      kind: fields.kind ?? 'text',
      ...(fields.conversation === undefined ? {} : { conversation: fields.conversation }),
      ...(fields.mode === undefined ? {} : { mode: fields.mode }),
    });

  const rows = () => driver.exec('SELECT principal, conversation, mode, last_used FROM conversation_modes ORDER BY principal, conversation');

  it('records the mode with the first message, and the first writer wins', () => {
    expect(inbound('w1', { conversation: A, mode: 'smart' })).toEqual({ status: 'fresh', mode: 'smart' });
    expect(inbound('w2', { conversation: A, mode: 'smart' })).toEqual({ status: 'fresh', mode: 'smart' });
    expect(inbound('w3', { conversation: A, mode: 'local' })).toEqual({ status: 'mode_mismatch', mode: 'smart' });
    expect(repo.modeOf(PRINCIPAL, A)).toBe('smart');
    expect(rows()).toHaveLength(1);
  });

  it('refuses the second of two first messages that disagree, a voice note as much as text', () => {
    expect(inbound('w1', { conversation: B, mode: 'local', kind: 'audio' })).toEqual({ status: 'fresh', mode: 'local' });
    expect(inbound('w2', { conversation: B, mode: 'smart' })).toEqual({ status: 'mode_mismatch', mode: 'local' });
    expect(repo.modeOf(PRINCIPAL, B)).toBe('local');
  });

  it('marks a mismatched message in the same step, so a retry of it is told the same', () => {
    inbound('w1', { conversation: A, mode: 'smart' });
    inbound('w2', { conversation: A, mode: 'local' });
    expect(repo.getInbound('w2')).toMatchObject({ decision: 'MODE_MISMATCH', error_code: 'E_MODE_MISMATCH' });
    expect(repo.getInbound('w1')).toMatchObject({ decision: null, error_code: null });
    // The retry is a duplicate: nothing is recorded or changed a second time.
    expect(inbound('w2', { conversation: A, mode: 'local' })).toEqual({ status: 'duplicate' });
    expect(repo.modeOf(PRINCIPAL, A)).toBe('smart');
  });

  it('records local the same way (the pipeline declares local for a text or voice message without a mode)', () => {
    expect(inbound('w1', { conversation: A, mode: 'local' })).toEqual({ status: 'fresh', mode: 'local' });
    expect(rows()).toEqual([{ principal: PRINCIPAL, conversation: A, mode: 'local', last_used: 1_000 }]);
    expect(inbound('w2', { conversation: A, mode: 'smart' })).toEqual({ status: 'mode_mismatch', mode: 'local' });
  });

  it('never stores the shared thread: it is always local, whatever was declared', () => {
    expect(inbound('w1', { conversation: '', mode: 'smart' })).toEqual({ status: 'fresh', mode: 'local' });
    expect(inbound('w2', { mode: 'smart' })).toEqual({ status: 'fresh', mode: 'local' });
    expect(inbound('w3', { conversation: '', mode: 'local' })).toEqual({ status: 'fresh', mode: 'local' });
    expect(rows()).toEqual([]);
    expect(repo.modeOf(PRINCIPAL, '')).toBe('local');
  });

  it('never checks a message that declares no mode (a button): it takes the recorded one', () => {
    inbound('w1', { conversation: A, mode: 'smart', at: 1_000 });
    expect(
      repo.recordInbound({ wamid: 'w2', principal: PRINCIPAL, receivedAt: 2_000, sentAt: 2_000, kind: 'button', conversation: A }),
    ).toEqual({ status: 'fresh', mode: 'smart' });
    // A button in a conversation with no mode yet records none.
    expect(
      repo.recordInbound({ wamid: 'w3', principal: PRINCIPAL, receivedAt: 2_000, sentAt: 2_000, kind: 'button', conversation: B }),
    ).toEqual({ status: 'fresh', mode: 'local' });
    expect(rows().map((row) => row['conversation'])).toEqual([A]);
    expect(rows()[0]?.['last_used']).toBe(2_000);
  });

  it('keeps each principal and conversation apart; unknown reads as local', () => {
    inbound('w1', { conversation: A, mode: 'smart' });
    expect(inbound('w2', { conversation: A, mode: 'local', principal: OTHER })).toEqual({ status: 'fresh', mode: 'local' });
    expect(repo.modeOf(PRINCIPAL, A)).toBe('smart');
    expect(repo.modeOf(OTHER, A)).toBe('local');
    expect(repo.modeOf(PRINCIPAL, B)).toBe('local');
  });

  it('moves last_used with every message', () => {
    inbound('w1', { conversation: A, mode: 'smart', at: 1_000 });
    inbound('w2', { conversation: A, mode: 'smart', at: 5_000 });
    expect(rows()[0]?.['last_used']).toBe(5_000);
  });

  it("forgets one principal's modes and consents, and nobody else's", () => {
    inbound('w1', { conversation: A, mode: 'smart' });
    inbound('w2', { conversation: B, mode: 'local' });
    inbound('w3', { conversation: A, mode: 'smart', principal: OTHER });
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'calendar', 1)", PRINCIPAL, A);
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'calendar', 1)", OTHER, A);

    repo.forgetConversationModes(PRINCIPAL);

    expect(rows().map((row) => row['principal'])).toEqual([OTHER]);
    expect(driver.exec('SELECT principal FROM conversation_consents')).toEqual([{ principal: OTHER }]);
    // Forgotten, the conversation takes whatever its next message declares.
    expect(inbound('w4', { conversation: A, mode: 'local' })).toEqual({ status: 'fresh', mode: 'local' });
  });

  it('purges modes and consents unused since the cutoff, and keeps the rest', () => {
    inbound('w1', { conversation: A, mode: 'smart', at: 1_000 });
    inbound('w2', { conversation: B, mode: 'smart', at: 5_000 });
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'mail', 1000)", PRINCIPAL, A);
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'mail', 5000)", PRINCIPAL, B);

    repo.purgeConversationModesBefore(2_000);

    expect(rows().map((row) => row['conversation'])).toEqual([B]);
    expect(driver.exec('SELECT conversation FROM conversation_consents')).toEqual([{ conversation: B }]);
  });

  it('refuses a mode outside the two at the database too', () => {
    expect(() =>
      driver.exec("INSERT INTO conversation_modes (principal, conversation, mode, last_used) VALUES ('p', 'c', 'fast', 1)"),
    ).toThrow();
  });
});
