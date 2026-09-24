/**
 * LLM output is untrusted input. These cases are the door it has to pass
 * through (CLAUDE.md invariant 3, PLAN §11.3).
 */
import { describe, expect, it } from 'vitest';
import { validateIntentDraft } from '../../../src/nlu/intent-schema.js';
import { MAX_QUERY_VARIANTS, MAX_TITLE_CHARS } from '../../../src/nlu/slot-schemas.js';

const ok = {
  intent: 'reminders.create',
  language: 'he',
  slots: {
    text: 'להתקשר לאבא',
    date: { kind: 'relative_days', offset: 1 },
    time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
  },
  missing: [],
  ambiguities: [],
};

describe('accepts well-formed drafts', () => {
  it('accepts a complete reminder', () => {
    const res = validateIntentDraft(ok);
    expect(res.ok).toBe(true);
  });

  it('accepts a draft with a missing slot declared', () => {
    const res = validateIntentDraft({
      ...ok,
      slots: { text: 'להתקשר לאבא', date: { kind: 'relative_days', offset: 1 } },
      missing: ['time'],
    });
    expect(res.ok).toBe(true);
  });

  it('defaults missing and ambiguities when the model omits them', () => {
    const res = validateIntentDraft({
      intent: 'reminders.list',
      language: 'he',
      slots: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.missing).toEqual([]);
      expect(res.draft.ambiguities).toEqual([]);
    }
  });

  it('accepts unsupported with empty slots', () => {
    expect(validateIntentDraft({ intent: 'unsupported', language: 'en', slots: {} }).ok).toBe(true);
  });
});

describe('rejects anything outside the contract', () => {
  const reject = (draft: unknown) => {
    const res = validateIntentDraft(draft);
    expect(res.ok).toBe(false);
  };

  it('rejects an unknown intent', () => {
    reject({ ...ok, intent: 'system.exec' });
  });

  it('rejects a tool name that is not in the registry', () => {
    reject({ ...ok, intent: 'calendar.share_calendar' });
  });

  it('rejects an extra top-level key', () => {
    reject({ ...ok, execute: true });
  });

  it('rejects an extra slot key', () => {
    reject({ ...ok, slots: { ...ok.slots, event_id: 'abc123' } });
  });

  it('rejects a slot belonging to another tool', () => {
    reject({ ...ok, slots: { ...ok.slots, query_variants: ['x'] } });
  });

  it('rejects an over-long title', () => {
    reject({ ...ok, slots: { ...ok.slots, text: 'א'.repeat(MAX_TITLE_CHARS + 1) } });
  });

  it('rejects too many query variants', () => {
    reject({
      intent: 'calendar.delete_event',
      language: 'he',
      slots: { query_variants: Array.from({ length: MAX_QUERY_VARIANTS + 1 }, (_, i) => `v${i}`) },
      missing: [],
      ambiguities: [],
    });
  });

  it('rejects an empty query_variants array', () => {
    reject({
      intent: 'calendar.delete_event',
      language: 'he',
      slots: { query_variants: [] },
      missing: [],
      ambiguities: [],
    });
  });

  it('rejects an unknown language', () => {
    reject({ ...ok, language: 'ru' });
  });

  it('rejects an out-of-range hour', () => {
    reject({ ...ok, slots: { ...ok.slots, time: { hour: 25, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } } });
  });

  it('rejects a non-integer offset', () => {
    reject({ ...ok, slots: { ...ok.slots, date: { kind: 'relative_days', offset: 1.5 } } });
  });

  it('rejects an unknown DateSpec kind', () => {
    reject({ ...ok, slots: { ...ok.slots, date: { kind: 'iso', value: '2026-09-25' } } });
  });

  it('rejects an ISO timestamp smuggled into a slot', () => {
    reject({ ...ok, slots: { ...ok.slots, date: '2026-09-25T08:00:00+03:00' } });
  });

  it('rejects an unknown part_of_day', () => {
    reject({ ...ok, slots: { ...ok.slots, time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'dawn' } } });
  });

  it('rejects a negative duration', () => {
    reject({ ...ok, slots: { text: 'x', date: { kind: 'in_duration', minutes: -10 } } });
  });

  it('rejects null, a string, and an array', () => {
    reject(null);
    reject('{"intent":"reminders.list"}');
    reject([ok]);
  });

  it('rejects a draft with slots missing entirely', () => {
    reject({ intent: 'reminders.create', language: 'he', missing: [], ambiguities: [] });
  });
});

describe('error reporting', () => {
  it('reports issue paths without echoing the values', () => {
    const res = validateIntentDraft({ ...ok, slots: { ...ok.slots, text: 'CANARY-SECRET' }, language: 'ru' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(JSON.stringify(res.issues)).not.toContain('CANARY');
      expect(res.issues.join(' ')).toContain('language');
    }
  });
});
