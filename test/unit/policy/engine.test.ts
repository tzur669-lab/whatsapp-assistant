/**
 * The policy engine (PLAN §6.4, §11.3). Test-first per CLAUDE.md.
 *
 * Policy is code and static config. Nothing that arrives over chat can change a
 * tier, a limit or an allowlist, so every case here is about what the *code*
 * decides — never about what a message asked for.
 */
import { describe, expect, it } from 'vitest';
import { decide, DEFAULT_LIMITS } from '../../../src/policy/engine.js';
import type { PolicyContext } from '../../../src/policy/engine.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    nowMs: NOW,
    messageSentAtMs: NOW - 1_000,
    forwarded: false,
    paused: false,
    usage: { perHour: 0, perDay: 0 },
    limits: DEFAULT_LIMITS,
    horizonExceeded: false,
    ...overrides,
  };
}

describe('tiers', () => {
  it('allows a read outright', () => {
    expect(decide('reminders.list', ctx())).toMatchObject({ decision: 'ALLOW' });
    expect(decide('calendar.list_events', ctx())).toMatchObject({ decision: 'ALLOW' });
  });

  it('allows a reversible create, which the caller follows with an Undo', () => {
    expect(decide('reminders.create', ctx())).toMatchObject({ decision: 'ALLOW', undoable: true });
    expect(decide('calendar.create_event', ctx())).toMatchObject({ decision: 'ALLOW', undoable: true });
  });

  it('requires confirmation to modify or delete one item', () => {
    expect(decide('reminders.cancel', ctx())).toMatchObject({ decision: 'CONFIRM' });
    expect(decide('calendar.move_event', ctx())).toMatchObject({ decision: 'CONFIRM' });
    expect(decide('calendar.delete_event', ctx())).toMatchObject({ decision: 'CONFIRM' });
  });

  it('denies a tool that is not in the registry', () => {
    // There is no Tier 4 code path; an unknown name cannot become one.
    expect(decide('system.exec' as never, ctx())).toMatchObject({
      decision: 'DENY',
      reason: 'unknown_tool',
    });
  });
});

describe('tier 3 — external-facing', () => {
  it('escalates event creation with attendees to a typed code', () => {
    const res = decide('calendar.create_event', ctx(), { hasAttendees: true });
    expect(res).toMatchObject({ decision: 'CONFIRM', tier: 3, requiresTypedCode: true });
  });

  it('leaves event creation without attendees at tier 1', () => {
    const res = decide('calendar.create_event', ctx(), { hasAttendees: false });
    expect(res).toMatchObject({ decision: 'ALLOW', tier: 1 });
  });
});

describe('pause', () => {
  it('denies every write while paused', () => {
    for (const tool of ['reminders.create', 'reminders.cancel', 'calendar.delete_event'] as const) {
      expect(decide(tool, ctx({ paused: true }))).toMatchObject({
        decision: 'DENY',
        reason: 'paused',
      });
    }
  });

  it('still allows reads while paused', () => {
    expect(decide('reminders.list', ctx({ paused: true }))).toMatchObject({ decision: 'ALLOW' });
  });

  it('is checked before anything else, so a stale paused write is still DENY', () => {
    const res = decide('reminders.create', ctx({ paused: true, messageSentAtMs: NOW - 3_600_000 }));
    expect(res).toMatchObject({ decision: 'DENY', reason: 'paused' });
  });
});

describe('stale messages', () => {
  const stale = { messageSentAtMs: NOW - 11 * 60_000 };

  it('escalates a stale write to a confirmation', () => {
    const res = decide('reminders.create', ctx(stale));
    expect(res).toMatchObject({ decision: 'CONFIRM', reason: 'stale_message' });
  });

  it('leaves a stale read alone', () => {
    expect(decide('reminders.list', ctx(stale))).toMatchObject({ decision: 'ALLOW' });
  });

  it('does not fire just inside the window', () => {
    const res = decide('reminders.create', ctx({ messageSentAtMs: NOW - 9 * 60_000 }));
    expect(res).toMatchObject({ decision: 'ALLOW' });
  });

  it('never downgrades a confirmation that was already required', () => {
    const res = decide('calendar.delete_event', ctx(stale));
    expect(res).toMatchObject({ decision: 'CONFIRM' });
  });

  it('treats a message from the future as stale rather than fresh', () => {
    // A clock skew must not be a way to look recent.
    const res = decide('reminders.create', ctx({ messageSentAtMs: NOW + 60 * 60_000 }));
    expect(res).toMatchObject({ decision: 'CONFIRM', reason: 'stale_message' });
  });
});

describe('forwarded messages', () => {
  it('escalates a forwarded write to a confirmation', () => {
    const res = decide('reminders.create', ctx({ forwarded: true }));
    expect(res).toMatchObject({ decision: 'CONFIRM', reason: 'forwarded' });
  });

  it('leaves a forwarded read alone', () => {
    expect(decide('reminders.list', ctx({ forwarded: true }))).toMatchObject({ decision: 'ALLOW' });
  });
});

describe('rate limits', () => {
  it('denies once the hourly limit is reached', () => {
    const res = decide(
      'reminders.create',
      ctx({ usage: { perHour: DEFAULT_LIMITS['reminders.create'].perHour, perDay: 0 } }),
    );
    expect(res).toMatchObject({ decision: 'DENY', reason: 'rate_limited' });
  });

  it('denies once the daily limit is reached', () => {
    const res = decide(
      'reminders.create',
      ctx({ usage: { perHour: 0, perDay: DEFAULT_LIMITS['reminders.create'].perDay } }),
    );
    expect(res).toMatchObject({ decision: 'DENY', reason: 'rate_limited' });
  });

  it('allows the last call under the limit', () => {
    const res = decide(
      'reminders.create',
      ctx({ usage: { perHour: DEFAULT_LIMITS['reminders.create'].perHour - 1, perDay: 0 } }),
    );
    expect(res).toMatchObject({ decision: 'ALLOW' });
  });

  it('applies limits to reads too, so a loop cannot burn the quota', () => {
    const res = decide(
      'reminders.list',
      ctx({ usage: { perHour: DEFAULT_LIMITS['reminders.list'].perHour, perDay: 0 } }),
    );
    expect(res).toMatchObject({ decision: 'DENY', reason: 'rate_limited' });
  });
});

describe('horizon (R8)', () => {
  it('requires confirmation for a far-future write', () => {
    const res = decide('reminders.create', ctx({ horizonExceeded: true }));
    expect(res).toMatchObject({ decision: 'CONFIRM', reason: 'far_future' });
  });

  it('ignores the horizon for a read', () => {
    expect(decide('reminders.list', ctx({ horizonExceeded: true }))).toMatchObject({
      decision: 'ALLOW',
    });
  });
});

describe('precedence', () => {
  it('denies rather than confirms when both apply', () => {
    // A denial is the safer answer, so it wins over an escalation.
    const res = decide(
      'reminders.create',
      ctx({
        forwarded: true,
        usage: { perHour: DEFAULT_LIMITS['reminders.create'].perHour, perDay: 0 },
      }),
    );
    expect(res).toMatchObject({ decision: 'DENY' });
  });

  it('reports every reason it found, not just the deciding one', () => {
    const res = decide(
      'reminders.create',
      ctx({ forwarded: true, messageSentAtMs: NOW - 20 * 60_000 }),
    );
    expect(res.decision).toBe('CONFIRM');
    expect(res.allReasons).toEqual(expect.arrayContaining(['forwarded', 'stale_message']));
  });

  it('is a pure function of its inputs', () => {
    const context = ctx({ forwarded: true });
    expect(decide('reminders.create', context)).toEqual(decide('reminders.create', context));
  });
});
