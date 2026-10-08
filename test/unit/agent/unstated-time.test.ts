/**
 * A tool call's TimeSpec without `meridiem` or `part_of_day` (2026-10-08).
 *
 * Gemini sent `{"hour":8,"minute":0}` for 6 of 19 tool calls in one eval, and
 * strict Zod rejected each. A missing key is filled with 'unspecified' — the
 * value that already means "not stated" — only where that cannot change the
 * time: never hour or minute, never a missing time, and never while the
 * conversation names the very thing the key would hold. The time it resolves
 * to is the one an explicit 'unspecified' resolves to, rules R4/R5 included.
 */
import { describe, expect, it } from 'vitest';
import { fillUnstatedTime } from '../../../src/agent/tools.js';
import { validateIntentDraft } from '../../../src/nlu/intent-schema.js';
import { resolveWhen } from '../../../src/time/resolve.js';
import type { TimeSpec } from '../../../src/time/resolve.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const TOMORROW = { kind: 'relative_days', offset: 1 } as const;
const UNSTATED = { meridiem: 'unspecified', part_of_day: 'unspecified' } as const;

const valid = (tool: string, slots: unknown) =>
  validateIntentDraft({ intent: tool, slots, language: 'he', missing: [], ambiguities: [] });

/** Fill, validate, resolve: the time the agent turn would act on. */
function resolved(slots: Record<string, unknown>, said: string) {
  const checked = valid('reminders.create', fillUnstatedTime('reminders.create', slots, said));
  if (!checked.ok) return 'rejected';
  const time = (checked.draft.slots as { time?: TimeSpec }).time;
  return resolveWhen({ date: TOMORROW, time }, { nowMs: NOW });
}

describe('fillUnstatedTime', () => {
  it('reads a bare "בשמונה" exactly as an explicit unspecified one: 08:00', () => {
    const filled = resolved({ text: 'x', date: TOMORROW, time: { hour: 8, minute: 0 } }, 'תזכיר לי מחר בשמונה');
    const explicit = resolveWhen({ date: TOMORROW, time: { hour: 8, minute: 0, ...UNSTATED } }, { nowMs: NOW });
    expect(filled).toEqual(explicit);
    expect(filled).toMatchObject({ kind: 'resolved', local: { hour: 8, minute: 0 } });
  });

  it('still asks about a bare small hour (R5), as an explicit unspecified one does', () => {
    const filled = resolved({ text: 'x', date: TOMORROW, time: { hour: 3, minute: 0 } }, 'תזכיר לי מחר בשלוש');
    expect(filled).toMatchObject({ kind: 'clarify', rule: 'R5' });
  });

  it('fills the keys only, never hour or minute, and leaves the input alone', () => {
    const input = { text: 'x', time: { hour: 8, minute: 30 } };
    expect(fillUnstatedTime('reminders.create', input, 'ב-8:30')).toEqual({ text: 'x', time: { hour: 8, minute: 30, ...UNSTATED } });
    expect(input.time).toEqual({ hour: 8, minute: 30 });
  });

  it('never makes up a time: a missing time, hour or minute stays missing', () => {
    expect(fillUnstatedTime('reminders.create', { text: 'x', date: TOMORROW }, 'מחר')).toEqual({ text: 'x', date: TOMORROW });
    expect(fillUnstatedTime('reminders.create', { time: { hour: 8 } }, 'ב-8')).toEqual({ time: { hour: 8 } });
    expect(fillUnstatedTime('reminders.create', { time: { minute: 0 } }, 'ב-8')).toEqual({ time: { minute: 0 } });
    expect(fillUnstatedTime('reminders.create', { time: { hour: '8', minute: 0 } }, 'ב-8')).toEqual({ time: { hour: '8', minute: 0 } });
    expect(valid('reminders.create', fillUnstatedTime('reminders.create', { time: { hour: 8 } }, 'ב-8')).ok).toBe(false);
  });

  it('never overwrites a stated key', () => {
    expect(fillUnstatedTime('reminders.create', { time: { hour: 8, minute: 0, meridiem: 'pm' } }, 'at 8pm')).toEqual({
      time: { hour: 8, minute: 0, meridiem: 'pm', part_of_day: 'unspecified' },
    });
    expect(fillUnstatedTime('reminders.create', { time: { hour: 8, minute: 0, part_of_day: 'evening' } }, 'ב-8 בערב')).toEqual({
      time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'evening' },
    });
  });

  it('leaves a 1–12 hour alone when the conversation names a part of the day: "8 בערב" is not 08:00', () => {
    expect(resolved({ text: 'x', date: TOMORROW, time: { hour: 8, minute: 0 } }, 'תזכיר לי מחר ב-8 בערב')).toBe('rejected');
    expect(resolved({ text: 'x', date: TOMORROW, time: { hour: 12, minute: 0 } }, '12 בלילה')).toBe('rejected');
    expect(resolved({ text: 'x', date: TOMORROW, time: { hour: 8, minute: 0 } }, 'at 8pm')).toBe('rejected');
  });

  it('fills a 13–23 hour whatever was said: no meridiem or part of the day moves it', () => {
    const filled = resolved({ text: 'x', date: TOMORROW, time: { hour: 20, minute: 0 } }, 'תזכיר לי מחר ב-8 בערב');
    expect(filled).toMatchObject({ kind: 'resolved', local: { hour: 20, minute: 0 } });
  });

  it('fills part_of_day next to a stated am or pm, which decides alone', () => {
    const filled = resolved({ text: 'x', date: TOMORROW, time: { hour: 8, minute: 0, meridiem: 'pm' } }, 'tomorrow at 8pm in the evening');
    expect(filled).toMatchObject({ kind: 'resolved', local: { hour: 20, minute: 0 } });
  });

  it('fills only the tool’s own TimeSpec slots, from and to included', () => {
    expect(
      fillUnstatedTime('calendar.move_event', { from_time: { hour: 9, minute: 0 }, to_time: { hour: 11, minute: 0 } }, 'מ-9 ל-11'),
    ).toEqual({ from_time: { hour: 9, minute: 0, ...UNSTATED }, to_time: { hour: 11, minute: 0, ...UNSTATED } });
    // `time` is not a slot of reminders.move: untouched, and projectSlots or Zod decide.
    expect(fillUnstatedTime('reminders.move', { time: { hour: 9, minute: 0 } }, 'ב-9')).toEqual({ time: { hour: 9, minute: 0 } });
    expect(fillUnstatedTime('reminders.list', { range: 'this_week' }, '')).toEqual({ range: 'this_week' });
  });

  it('passes anything that is not an object through', () => {
    expect(fillUnstatedTime('reminders.create', null, '')).toBeNull();
    expect(fillUnstatedTime('reminders.create', [1], '')).toEqual([1]);
    expect(fillUnstatedTime('reminders.create', { time: [8, 0] }, '')).toEqual({ time: [8, 0] });
  });
});
