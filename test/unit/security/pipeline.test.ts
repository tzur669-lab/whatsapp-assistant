import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = [
  { id: 1, sql: readFileSync(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8') },
];

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PRINCIPAL = 'p_abcdef012345';

function textEvent(overrides: Partial<Extract<InboundEvent, { kind: 'text' }>> = {}): InboundEvent {
  return {
    kind: 'text',
    wamid: 'wamid.A',
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text: 'שלום',
    forwarded: false,
    ...overrides,
  };
}

describe('handleInbound', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = () => ({ repo, log, now: () => NOW, principal: PRINCIPAL });

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('answers /help with the help text', async () => {
    const out = await handleInbound(textEvent({ text: '/help' }), deps());
    expect(out).toEqual({ action: 'reply', text: he.help });
  });

  it('answers /ping', async () => {
    const out = await handleInbound(textEvent({ text: '/ping' }), deps());
    expect(out).toEqual({ action: 'reply', text: he.pong });
  });

  it('drops a replayed wamid without replying twice', async () => {
    const first = await handleInbound(textEvent({ text: '/ping' }), deps());
    const second = await handleInbound(textEvent({ text: '/ping' }), deps());
    expect(first.action).toBe('reply');
    expect(second).toEqual({ action: 'none', reason: 'duplicate' });
  });

  it('opens the 24h window on an accepted message', async () => {
    await handleInbound(textEvent({ text: '/ping' }), deps());
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(NOW);
  });

  it('does not open the window for a duplicate', async () => {
    await handleInbound(textEvent({ text: '/ping' }), deps());
    const later = { ...deps(), now: () => NOW + 60_000 };
    await handleInbound(textEvent({ text: '/ping' }), later);
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(NOW);
  });

  it('answers an unsupported message type with the canned reply', async () => {
    const out = await handleInbound(
      { kind: 'unsupported', wamid: 'wamid.B', from: '972500000000', sentAtMs: NOW, messageType: 'image', forwarded: false },
      deps(),
    );
    expect(out).toEqual({ action: 'reply', text: he.unsupportedType });
  });

  it('does not reply to a delivery status and does not record it as inbound', async () => {
    const out = await handleInbound(
      { kind: 'status', wamid: 'wamid.OUT', status: 'delivered', sentAtMs: NOW, recipient: '972500000000' },
      deps(),
    );
    expect(out).toEqual({ action: 'none', reason: 'status' });
    expect(repo.getInbound('wamid.OUT')).toBeNull();
  });

  it('falls back to "not understood" for free text until NLU lands', async () => {
    const out = await handleInbound(textEvent({ text: 'תזכיר לי מחר ב-8' }), deps());
    expect(out).toEqual({ action: 'reply', text: he.notUnderstood });
  });

  it('records a stale message as stale without executing anything', async () => {
    await handleInbound(textEvent({ text: 'תזכיר לי מחר', sentAtMs: NOW - 20 * 60_000 }), deps());
    const entry = log.captured.find((l) => l.event === 'nlu_not_configured');
    expect(entry?.fields['stale']).toBe(true);
  });

  it('writes an audit row for an executed command', async () => {
    await handleInbound(textEvent({ text: '/help' }), deps());
    const rows = driver.exec('SELECT * FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'ALLOW', tool: 'help', tier: 0 });
  });

  it('never logs the message text', async () => {
    await handleInbound(textEvent({ text: 'CANARY-IN-PIPELINE' }), deps());
    expect(JSON.stringify(log.captured)).not.toContain('CANARY');
  });
});
