/**
 * The fallback chain and the prompt's privacy boundary
 * (CLAUDE.md invariants 1 and 2, PLAN §6.2, §11.5).
 */
import { describe, expect, it } from 'vitest';
import { parseWithFallback } from '../../../src/nlu/provider.js';
import type { NluProvider, NluResponse } from '../../../src/nlu/provider.js';
import { buildPrompt, estimatePromptTokens, PROMPT_VERSION } from '../../../src/nlu/prompt.js';
import { toolCatalog, TOOL_NAMES, REGISTRY } from '../../../src/tools/registry.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const INPUT = {
  text: 'תזכיר לי מחר ב-8 להתקשר לאבא',
  nowLocalIso: '2026-09-24T21:00:00+03:00',
  weekday: 'Thursday',
  tools: toolCatalog(),
};

const GOOD_DRAFT = {
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

function provider(name: string, response: NluResponse | (() => never)): NluProvider {
  return {
    name,
    parse: () => (typeof response === 'function' ? response() : Promise.resolve(response)),
  };
}

const okResponse = (draft: unknown): NluResponse => ({
  ok: true,
  draft,
  usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
});

describe('parseWithFallback', () => {
  it('returns the first valid draft and does not call later providers', async () => {
    let secondCalled = false;
    const second: NluProvider = {
      name: 'second',
      parse: () => {
        secondCalled = true;
        return Promise.resolve(okResponse(GOOD_DRAFT));
      },
    };

    const res = await parseWithFallback(
      [provider('first', okResponse(GOOD_DRAFT)), second],
      INPUT,
      createFakeLogger(),
    );

    expect(res).toMatchObject({ ok: true, provider: 'first', attempts: 1 });
    expect(secondCalled).toBe(false);
  });

  it('falls through a rate-limited provider', async () => {
    const res = await parseWithFallback(
      [
        provider('primary', { ok: false, error: { code: 'rate_limited', status: 429 } }),
        provider('secondary', okResponse(GOOD_DRAFT)),
      ],
      INPUT,
      createFakeLogger(),
    );
    expect(res).toMatchObject({ ok: true, provider: 'secondary', attempts: 2 });
  });

  it('falls through a timeout', async () => {
    const res = await parseWithFallback(
      [provider('primary', { ok: false, error: { code: 'timeout' } }), provider('rules', okResponse(GOOD_DRAFT))],
      INPUT,
      createFakeLogger(),
    );
    expect(res).toMatchObject({ ok: true, provider: 'rules' });
  });

  it('treats a schema-invalid draft as a failure and moves on', async () => {
    const res = await parseWithFallback(
      [
        provider('primary', okResponse({ intent: 'system.exec', language: 'he', slots: {} })),
        provider('secondary', okResponse(GOOD_DRAFT)),
      ],
      INPUT,
      createFakeLogger(),
    );
    expect(res).toMatchObject({ ok: true, provider: 'secondary', attempts: 2 });
  });

  it('survives a provider that throws', async () => {
    const res = await parseWithFallback(
      [
        provider('boom', () => {
          throw new Error('kaboom');
        }),
        provider('rules', okResponse(GOOD_DRAFT)),
      ],
      INPUT,
      createFakeLogger(),
    );
    expect(res).toMatchObject({ ok: true, provider: 'rules' });
  });

  it('fails closed when every provider fails', async () => {
    const res = await parseWithFallback(
      [
        provider('a', { ok: false, error: { code: 'provider_error' } }),
        provider('b', okResponse({ nonsense: true })),
      ],
      INPUT,
      createFakeLogger(),
    );
    expect(res).toEqual({ ok: false, errorCode: 'schema_invalid', attempts: 2 });
  });

  it('fails closed with no providers configured', async () => {
    const res = await parseWithFallback([], INPUT, createFakeLogger());
    expect(res).toEqual({ ok: false, errorCode: 'not_configured', attempts: 0 });
  });

  it('never logs the message text or the parsed slot values', async () => {
    const log = createFakeLogger();
    await parseWithFallback(
      [
        provider('primary', okResponse({ intent: 'nope', language: 'he', slots: {} })),
        provider('rules', okResponse(GOOD_DRAFT)),
      ],
      { ...INPUT, text: 'CANARY-IN-NLU' },
      log,
    );
    const dump = JSON.stringify(log.captured);
    expect(dump).not.toContain('CANARY');
    expect(dump).not.toContain('להתקשר לאבא');
  });
});

describe('buildPrompt — the privacy boundary', () => {
  const { system, user } = buildPrompt(INPUT);
  const whole = `${system}\n${user}`;

  it('includes the message, the local time and the weekday', () => {
    expect(user).toContain(INPUT.text);
    expect(user).toContain('2026-09-24T21:00:00+03:00');
    expect(user).toContain('Thursday');
  });

  it('lists every enabled tool, generated from the registry', () => {
    for (const name of TOOL_NAMES) {
      expect(system).toContain(name);
    }
  });

  it('carries no tier, scope or rate-limit information', () => {
    expect(whole).not.toMatch(/\btier\b/i);
    expect(whole).not.toContain('googleapis.com');
    expect(whole).not.toMatch(/perHour|perDay|rateLimit/);
  });

  it('never asks the model for an ISO timestamp', () => {
    expect(system).toMatch(/No ISO/i);
    expect(system).toMatch(/Never compute a date or time/i);
  });

  it('tells the model to treat the message as data', () => {
    expect(system).toMatch(/DATA/);
  });

  it('forbids inventing slots and ids', () => {
    expect(system).toMatch(/Never fill a slot the user did not state/i);
    expect(system).toMatch(/Never an id/i);
  });

  it('stays small enough for the free tier to sustain', () => {
    // Prompt size is a throughput ceiling: requests per minute = 8000 / tokens,
    // requests per day = 200000 / tokens (PLAN §2). This guards the budget the
    // way a bundle-size test guards a page.
    expect(estimatePromptTokens(INPUT)).toBeLessThan(1200);
  });

  it('is versioned so eval results can be pinned to it', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });

  it('exposes only name, description and slot shape per tool', () => {
    const entry = toolCatalog(['reminders.create'])[0]!;
    expect(Object.keys(entry).sort()).toEqual(['description', 'name', 'slotTypes', 'slots']);
    expect(REGISTRY['reminders.create'].tier).toBe(1);
  });

  it('describes enum slots with their allowed values, so drafts stay valid', () => {
    const entry = toolCatalog(['reminders.list'])[0]!;
    expect(entry.slotTypes).toEqual([
      'range: "this_week"|"next_week"|"weekend"?',
    ]);
  });

  it('describes date, time, number and array slots', () => {
    const create = toolCatalog(['calendar.create_event'])[0]!.slotTypes.join(' ');
    expect(create).toContain('date: DateSpec?');
    expect(create).toContain('time: TimeSpec?');
    expect(create).toContain('duration_minutes: int?');
    expect(create).toContain('attendees: string[]?');
  });
});
