/**
 * The app's `/` list (`ChatLogic.COMMANDS` in the Android app) against the
 * router. Two drift guards: every app entry is a command the server matches,
 * and every server command kind is offered in the app, unless it is listed
 * below as deliberately absent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COMMAND_KINDS, matchCommand } from '../../../src/core/router.js';

const CHAT_LOGIC = 'apps/call-companion/app/src/main/java/com/tzur/callcompanion/ChatLogic.kt';

/** `Command("<usage>", "<insert>", "<description>")`, in source order. */
const ENTRIES = [...readFileSync(CHAT_LOGIC, 'utf8').matchAll(/Command\("([^"]+)", "([^"]+)", "[^"]+"\)/g)].map(
  (m) => ({ usage: m[1]!, insert: m[2]! }),
);

/** A placeholder in a usage, filled the way the user would. */
const SAMPLES: Readonly<Record<string, string>> = {
  '<שעה>': '7',
  '<דקות>': '20',
  '<שם>': 'דנה',
  '<יום.חודש>': '14.3',
  '<עיר>': 'חיפה',
  '<קישור>': 'https://example.com/cal.ics',
};

function filled(usage: string): string {
  return usage.replace(/<[^>]+>/g, (slot) => {
    const sample = SAMPLES[slot];
    if (!sample) throw new Error(`no sample for ${slot}`);
    return sample;
  });
}

/**
 * Kinds the app does not offer. `/budget` has nothing to count in the app
 * (§6.18); `/pair` issues a code for pairing, which the app does itself.
 */
const NOT_IN_APP: ReadonlySet<string> = new Set(['budget', 'pair']);

describe('the app command list', () => {
  it('was read from the app source', () => {
    expect(ENTRIES.length).toBeGreaterThan(20);
  });

  it('offers only commands the server matches', () => {
    for (const { usage } of ENTRIES) {
      expect(matchCommand(filled(usage)), usage).not.toBeNull();
    }
  });

  it('offers every server command kind', () => {
    const offered = new Set(ENTRIES.map(({ usage }) => matchCommand(filled(usage))?.kind));
    for (const kind of COMMAND_KINDS) {
      if (NOT_IN_APP.has(kind)) continue;
      expect(offered.has(kind), kind).toBe(true);
    }
  });

  it('offers every connect grant and digest section', () => {
    const usages = ENTRIES.map(({ usage }) => usage);
    for (const grant of ['google', 'gmail', 'tasks', 'drive']) expect(usages).toContain(`/connect ${grant}`);
    for (const section of ['conflicts', 'bills']) {
      expect(usages).toContain(`/digest ${section} on`);
      expect(usages).toContain(`/digest ${section} off`);
    }
  });
});
