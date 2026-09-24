/**
 * A fake NLU provider: hands back a scripted draft with no network and no
 * tokens. Unit tests make no network calls (CLAUDE.md, Testing rules), and the
 * real provider's daily budget is far too small to spend on pipeline tests.
 *
 * The drafts it returns are deliberately raw `unknown`, exactly as a model's
 * output arrives, so the schema still validates them on the way through.
 */
import type { NluProvider, NluResponse } from '../../src/nlu/provider.js';
import type { PromptInput } from '../../src/nlu/prompt.js';

export type FakeNlu = NluProvider & {
  /** Every prompt input the pipeline built, for asserting what the model saw. */
  inputs: PromptInput[];
};

export function createFakeNlu(script: (unknown | NluResponse)[]): FakeNlu {
  const inputs: PromptInput[] = [];
  let index = 0;

  return {
    name: 'fake-nlu',
    inputs,
    async parse(input: PromptInput): Promise<NluResponse> {
      inputs.push(input);
      const step = script[Math.min(index++, script.length - 1)];

      if (step && typeof step === 'object' && 'ok' in step) return step as NluResponse;
      return {
        ok: true,
        draft: step,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  };
}

/** A well-formed draft, with the slot keys a strict schema would produce. */
export function draft(
  intent: string,
  slots: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    intent,
    language: 'he',
    slots,
    missing: [],
    ambiguities: [],
    ...overrides,
  };
}

/** `תזכיר לי מחר ב-8` as the model would encode it. */
export const TOMORROW_AT_EIGHT = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};
