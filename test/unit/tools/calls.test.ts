/**
 * `calls.place` (PLAN §6.17): the words go to the phone, a number never does,
 * and the phone's own screen is the confirmation.
 */
import { describe, expect, it } from 'vitest';
import { callsPlace, looksLikeNumber } from '../../../src/tools/calls.js';
import { decide, DEFAULT_LIMITS } from '../../../src/policy/engine.js';
import type { PolicyContext } from '../../../src/policy/engine.js';
import type { CallDispatcher, DispatchResult } from '../../../src/device/calls.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { callText } from '../../../src/render/calls.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');

function dispatcher(result: DispatchResult) {
  const calls: Array<{ principal: string; variants: readonly string[] }> = [];
  const impl: CallDispatcher = {
    async dispatch(principal, variants) {
      calls.push({ principal, variants });
      return result;
    },
  };
  return { impl, calls };
}

const ctxWith = (calls?: CallDispatcher): ToolContext =>
  ({
    principal: 'p_test',
    nowMs: NOW,
    lang: 'he',
    log: createFakeLogger(),
    ...(calls ? { calls } : {}),
  }) as unknown as ToolContext;

describe('looksLikeNumber', () => {
  it.each(['0501234567', '050-123-4567', '+972 50 000 0000', '+1 5', '972500000000'])(
    'refuses %s',
    (text) => expect(looksLikeNumber(text)).toBe(true),
  );

  it.each(['דוד דני', 'אמא', 'Dani 2', 'חדר 101', 'Mom'])('lets the name %s through', (text) =>
    expect(looksLikeNumber(text)).toBe(false),
  );
});

describe('calls.place resolve', () => {
  it('takes the words to match, trimmed', () => {
    expect(callsPlace.resolve({ query_variants: [' דוד דני ', 'דני'] }, ctxWith())).toEqual({
      kind: 'ready',
      input: { queryVariants: ['דוד דני', 'דני'] },
    });
  });

  it('asks who, when no one was named', () => {
    for (const slots of [{}, { query_variants: [] }, { query_variants: ['  '] }]) {
      expect(callsPlace.resolve(slots, ctxWith())).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'target' },
      });
    }
  });

  it('refuses a number written in the message, even beside a name', () => {
    expect(callsPlace.resolve({ query_variants: ['דני', '0501234567'] }, ctxWith())).toEqual({
      kind: 'clarify',
      clarify: { code: 'call_number_refused' },
    });
  });
});

describe('calls.place execute', () => {
  const input = { queryVariants: ['דוד דני'] };

  it('dispatches to the phone and leaves the reply for later', async () => {
    const d = dispatcher({ ok: true, dispatchId: 'abc' });
    const result = await callsPlace.execute(input, ctxWith(d.impl));
    expect(result).toEqual({ text: '', replyLater: true, externalRef: 'abc' });
    expect(d.calls).toEqual([{ principal: 'p_test', variants: ['דוד דני'] }]);
  });

  it('says there is no phone to call from', async () => {
    const d = dispatcher({ ok: false, reason: 'no_device' });
    expect((await callsPlace.execute(input, ctxWith(d.impl))).text).toBe(callText.noDevice('he'));
  });

  it('says the phone was not reachable when the push failed', async () => {
    const d = dispatcher({ ok: false, reason: 'push_failed' });
    expect((await callsPlace.execute(input, ctxWith(d.impl))).text).toBe(callText.phoneUnavailable('he'));
  });

  it('says calls are not set up when the server has no dispatcher', async () => {
    expect((await callsPlace.execute(input, ctxWith())).text).toBe(callText.notConfigured('he'));
  });

  it('refuses a stored input that is not what resolve produced', async () => {
    await expect(callsPlace.execute({ queryVariants: [] }, ctxWith())).rejects.toThrow('E_TOOL_INPUT_INVALID');
  });
});

describe('calls.place policy', () => {
  const base: PolicyContext = {
    nowMs: NOW,
    messageSentAtMs: NOW - 1_000,
    forwarded: false,
    paused: false,
    usage: { perHour: 0, perDay: 0 },
    limits: DEFAULT_LIMITS,
    horizonExceeded: false,
  };

  it('is Tier 3, confirmed on the phone — no chat button, no typed code', () => {
    const result = decide('calls.place', base);
    expect(result).toMatchObject({
      decision: 'CONFIRM',
      tier: 3,
      confirmOnDevice: true,
      requiresTypedCode: false,
      undoable: false,
    });
  });

  it('is refused while paused', () => {
    expect(decide('calls.place', { ...base, paused: true }).decision).toBe('DENY');
  });

  it('allows five an hour and twenty a day', () => {
    expect(decide('calls.place', { ...base, usage: { perHour: 5, perDay: 5 } }).reason).toBe('rate_limited');
    expect(decide('calls.place', { ...base, usage: { perHour: 0, perDay: 20 } }).reason).toBe('rate_limited');
    expect(decide('calls.place', { ...base, usage: { perHour: 4, perDay: 19 } }).decision).toBe('CONFIRM');
  });

  it('still goes to the phone for a forwarded message, where the number is shown', () => {
    const result = decide('calls.place', { ...base, forwarded: true });
    expect(result.confirmOnDevice).toBe(true);
    expect(result.allReasons).toContain('forwarded');
  });

  it('never marks any other tool as confirmed on the device', () => {
    for (const tool of ['reminders.cancel', 'calendar.delete_event', 'calendar.move_event'] as const) {
      expect(decide(tool, base).confirmOnDevice, tool).toBe(false);
    }
  });
});
