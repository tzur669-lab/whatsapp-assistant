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

  it("drops a Gemini thought signature wherever it sits (2026-10-08)", () => {
    const log = createLogger();
    log.warn('agent_call_failed', {
      call: { id: 'call_1', signature: 'CANARY1', extra_content: { google: { thought_signature: 'CANARY2' } } },
      response: { tool_calls: [{ id: 'x' }], thought_signature: 'CANARY3', thoughtSignature: 'CANARY4' },
      toolCalls: 1,
    });
    const line = written[0]!;
    expect(line).not.toContain('CANARY');
    expect(JSON.parse(line).toolCalls).toBe(1);
  });

  it('truncates unexpectedly long string values', () => {
    const log = createLogger();
    log.info('e', { detail: 'x'.repeat(500) });
    const rec = JSON.parse(written[0]!);
    expect(rec.detail.length).toBeLessThanOrEqual(128);
  });

  it('never throws on circular structures', () => {
    const log = createLogger();
    const cyclic: Record<string, unknown> = { code: 'E' };
    cyclic.self = cyclic;
    expect(() => log.warn('cyclic', cyclic)).not.toThrow();
  });

  it('still marks a real cycle as [circular]', () => {
    const log = createLogger();
    const cyclic: Record<string, unknown> = { code: 'E' };
    cyclic.self = cyclic;
    log.warn('cyclic', { outer: cyclic });
    expect(JSON.parse(written[0]!).outer).toEqual({ code: 'E', self: '[circular]' });
  });

  it('logs an object shared by two fields in full both times', () => {
    const log = createLogger();
    const shared = { code: 'E_SHARED', count: 2 };
    log.info('shared', { first: shared, second: shared, list: [shared, shared] });
    const rec = JSON.parse(written[0]!);
    expect(rec.first).toEqual(shared);
    expect(rec.second).toEqual(shared);
    expect(rec.list).toEqual([shared, shared]);
  });

  describe('errorCode backup check', () => {
    const codeOf = (value: unknown): unknown => {
      createLogger().error('failed', { errorCode: value });
      return JSON.parse(written[written.length - 1]!).errorCode;
    };

    it('keeps real codes', () => {
      expect(codeOf('E_TOOL_FAILED')).toBe('E_TOOL_FAILED');
      expect(codeOf('E_WA_131047')).toBe('E_WA_131047');
      expect(codeOf('E_ICAL_HTTP_404')).toBe('E_ICAL_HTTP_404');
      expect(codeOf('model_unavailable')).toBe('model_unavailable');
      expect(codeOf('SyntaxError')).toBe('SyntaxError');
    });

    it('replaces text with spaces, non-ASCII, or over 64 characters', () => {
      expect(codeOf('Unexpected token x in JSON')).toBe('E_UNCLASSIFIED');
      expect(codeOf('פגישה')).toBe('E_UNCLASSIFIED');
      expect(codeOf('E_' + 'X'.repeat(63))).toBe('E_UNCLASSIFIED');
      expect(codeOf('E_' + 'X'.repeat(62))).toBe('E_' + 'X'.repeat(62));
      expect(codeOf('E_A	B')).toBe('E_UNCLASSIFIED');
    });

    it('replaces a value that is not a string', () => {
      expect(codeOf(404)).toBe('E_UNCLASSIFIED');
      expect(codeOf({ code: 'E_X' })).toBe('E_UNCLASSIFIED');
    });

    it('leaves an absent code absent', () => {
      createLogger().error('failed', { errorCode: undefined });
      expect(JSON.parse(written[0]!)).not.toHaveProperty('errorCode');
    });
  });
});
