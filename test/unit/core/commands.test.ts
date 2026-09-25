/**
 * The system command surface (PLAN §6.4, §11.3).
 *
 * Drift guards, in the same spirit as `tools/registry.test.ts`. The command list
 * lives in four places — the router, the help text, PLAN and the runbook — and
 * the failure mode is quiet: a command that works but is documented nowhere, or
 * one that is offered in `/help` and answers "not available yet".
 *
 * Each of these fails the build for a mistake that would otherwise show up as a
 * confusing reply months later.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchCommand } from '../../../src/core/router.js';
import type { Command } from '../../../src/core/router.js';
import { he } from '../../../src/render/he.js';
import { stripIsolates } from '../../../src/render/bidi.js';

/**
 * Every command, with a message that invokes it.
 *
 * Written out rather than derived from the type: a command added to the union
 * without a line here fails the exhaustiveness check below, which is the point.
 */
const INVOCATIONS: Record<Command['kind'], string> = {
  help: '/help',
  ping: '/ping',
  status: '/status',
  pause: '/pause',
  resume: '/resume',
  budget: '/budget',
  connect_google: '/connect google',
  digest: '/digest',
  shabbat: '/shabbat',
  ical: '/ical',
};

/**
 * Commands deliberately absent from `/help`.
 *
 * `/ping` is a liveness check for whoever is operating the thing, not a feature.
 * Anything else added here is a decision, and this list is where it is recorded.
 */
const HIDDEN: ReadonlySet<Command['kind']> = new Set(['ping']);

const helpText = stripIsolates(he.help);

describe('every command is reachable', () => {
  it('matches the message that is supposed to invoke it', () => {
    for (const [kind, text] of Object.entries(INVOCATIONS)) {
      expect(matchCommand(text)?.kind, text).toBe(kind);
    }
  });

  it('is case-insensitive, because a phone keyboard capitalises', () => {
    expect(matchCommand('/HELP')?.kind).toBe('help');
    expect(matchCommand('/Status')?.kind).toBe('status');
  });

  it('tolerates the whitespace a message picks up', () => {
    expect(matchCommand('  /help  ')?.kind).toBe('help');
  });
});

describe('every command a user can see is documented', () => {
  it('appears in /help', () => {
    for (const kind of Object.keys(INVOCATIONS) as Command['kind'][]) {
      if (HIDDEN.has(kind)) continue;
      const slash = INVOCATIONS[kind].split(' ')[0]!;
      expect(helpText, `${slash} is not in /help`).toContain(slash);
    }
  });

  it('offers nothing in /help that is not a command', () => {
    // The opposite drift: a line in the help text promising something the
    // router never matches, which answers "not available yet".
    const promised = helpText.match(/\/[a-z]+/g) ?? [];
    for (const slash of new Set(promised)) {
      expect(matchCommand(slash) ?? matchCommand(`${slash} google`), slash).not.toBeNull();
    }
  });

  it('is listed in the runbook, which is what an operator reads', () => {
    const runbook = readFileSync(new URL('../../../ops/runbook.md', import.meta.url), 'utf8');
    for (const kind of Object.keys(INVOCATIONS) as Command['kind'][]) {
      const slash = INVOCATIONS[kind].split(' ')[0]!;
      expect(runbook, `${slash} is missing from ops/runbook.md`).toContain(slash);
    }
  });
});

describe('free text is not a command', () => {
  it('leaves an ordinary message to the parser', () => {
    for (const text of ['תזכיר לי מחר ב-8', 'מה יש לי ביומן', 'כן', '8', '']) {
      expect(matchCommand(text), text).toBeNull();
    }
  });

  it('does not match a command with something appended', () => {
    // `/status and also cancel everything` is not `/status`. Anchoring matters:
    // a command is matched before the parser and never confirmed.
    expect(matchCommand('/status and also cancel everything')).toBeNull();
    expect(matchCommand('/pause please')).toBeNull();
  });

  it('does not match a command mentioned inside a sentence', () => {
    expect(matchCommand('what does /pause do?')).toBeNull();
  });
});

describe('the commands that carry a value', () => {
  it('reads the digest hour, and refuses one that is not an hour', () => {
    expect(matchCommand('/digest 7')).toEqual({ kind: 'digest', set: 7 });
    expect(matchCommand('/digest off')).toEqual({ kind: 'digest', set: 'off' });
    expect(matchCommand('/digest 25')).toBeNull();
  });

  it('reads the shabbat toggle', () => {
    expect(matchCommand('/shabbat on')).toEqual({ kind: 'shabbat', set: true });
    expect(matchCommand('/shabbat off')).toEqual({ kind: 'shabbat', set: false });
  });

  it('captures an iCal link loosely and leaves validating it to url.ts', () => {
    // The router's job is to know this is `/ical`; whether the link may be
    // fetched is a security question answered in one place (§6.15).
    expect(matchCommand('/ical https://example.test/f.ics')).toEqual({
      kind: 'ical',
      set: 'https://example.test/f.ics',
    });
    expect(matchCommand('/ical off')).toEqual({ kind: 'ical', set: 'off' });
  });
});
