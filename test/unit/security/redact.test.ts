import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, hashPrincipal, BANNED_LOG_FIELDS } from '../../../src/security/redact.js';

describe('hashPrincipal', () => {
  it('produces a short stable keyed hash, not the number', async () => {
    const a = await hashPrincipal('972500000000', 'log-key');
    const b = await hashPrincipal('972500000000', 'log-key');
    expect(a).toBe(b);
    expect(a).not.toContain('972500000000');
    expect(a).toMatch(/^p_[0-9a-f]{12}$/);
  });

  it('changes with the key, so hashes are not linkable across deployments', async () => {
    const a = await hashPrincipal('972500000000', 'key-a');
    const b = await hashPrincipal('972500000000', 'key-b');
    expect(a).not.toBe(b);
  });

  it('normalizes formatting before hashing', async () => {
    const a = await hashPrincipal('+972-50-000-0000', 'k');
    const b = await hashPrincipal('972500000000', 'k');
    expect(a).toBe(b);
  });
});

describe('createLogger', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('emits structured JSON with the allowed fields', () => {
    const log = createLogger();
    log.info('intent_resolved', { wamid: 'wamid.X', intent: 'reminders.create', tier: 1, decision: 'ALLOW', latencyMs: 42 });
    expect(written).toHaveLength(1);
    const rec = JSON.parse(written[0]!);
    expect(rec).toMatchObject({
      level: 'info',
      event: 'intent_resolved',
      intent: 'reminders.create',
      tier: 1,
      decision: 'ALLOW',
      latencyMs: 42,
    });
    expect(typeof rec.ts).toBe('string');
  });

  it('drops banned fields instead of logging them', () => {
    const log = createLogger();
    log.info('inbound', {
      wamid: 'wamid.X',
      // These must never reach the log sink.
      text: 'CANARY-SECRET-STRING',
      body: 'CANARY-SECRET-STRING',
      title: 'CANARY-SECRET-STRING',
      from: '972500000000',
      token: 'ya29.CANARY',
    });
    const line = written[0]!;
    expect(line).not.toContain('CANARY');
    expect(line).not.toContain('972500000000');
    const rec = JSON.parse(line);
    for (const field of BANNED_LOG_FIELDS) {
      expect(rec).not.toHaveProperty(field);
    }
    expect(rec.wamid).toBe('wamid.X');
  });

  it('drops banned fields nested inside objects', () => {
    const log = createLogger();
    log.error('tool_failed', { detail: { text: 'CANARY', code: 'E_CONFLICT' } });
    const line = written[0]!;
    expect(line).not.toContain('CANARY');
    expect(line).toContain('E_CONFLICT');
  });

  it('truncates unexpectedly long string values', () => {
    const log = createLogger();
    log.info('e', { errorCode: 'x'.repeat(500) });
    const rec = JSON.parse(written[0]!);
    expect(rec.errorCode.length).toBeLessThanOrEqual(128);
  });

  it('never throws on circular structures', () => {
    const log = createLogger();
    const cyclic: Record<string, unknown> = { code: 'E' };
    cyclic.self = cyclic;
    expect(() => log.warn('cyclic', cyclic)).not.toThrow();
  });
});
