/**
 * Deterministic command routing. Anything matched here never reaches the LLM
 * (PLAN §6.4). Unmatched text falls through to NLU in a later phase.
 */
export type Command =
  | { kind: 'help' }
  | { kind: 'ping' }
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'budget' }
  | { kind: 'connect_google' }
  /**
   * `/digest`, `/digest 7`, `/digest off` (PLAN §6.12). The only command that
   * carries a value, so it is matched separately from the fixed table below.
   */
  | { kind: 'digest'; set: number | 'off' | null }
  /** `/shabbat`, `/shabbat on`, `/shabbat off` (PLAN §6.13). Off by default. */
  | { kind: 'shabbat'; set: boolean | null }
  /** `/ical <url>`, `/ical off`, `/ical` (PLAN §6.15). */
  | { kind: 'ical'; set: string | 'off' | null }
  /** `/birthday`, `/birthday <name> <d.m>`, `/birthday מחק <name>` (PLAN §6.16). */
  | {
      kind: 'birthday';
      action:
        | { kind: 'list' }
        | { kind: 'add'; name: string; day: number; month: number }
        | { kind: 'remove'; name: string }
        /** Recognised as `/birthday`, but not in a shape that says what to do. */
        | { kind: 'malformed' };
    };

const COMMANDS: ReadonlyArray<readonly [RegExp, Command]> = [
  [/^\/help$|^עזרה$/i, { kind: 'help' }],
  [/^\/ping$/i, { kind: 'ping' }],
  [/^\/status$/i, { kind: 'status' }],
  [/^\/pause$/i, { kind: 'pause' }],
  [/^\/resume$/i, { kind: 'resume' }],
  [/^\/budget$/i, { kind: 'budget' }],
  [/^\/shabbat$/i, { kind: 'shabbat', set: null }],
  [/^\/shabbat\s+on$/i, { kind: 'shabbat', set: true }],
  [/^\/shabbat\s+off$/i, { kind: 'shabbat', set: false }],
  [/^\/connect\s+google$/i, { kind: 'connect_google' }],
];

const DIGEST = /^\/digest(?:\s+(off|\d{1,2}))?$/i;

/** The argument is a URL, so it is captured loosely here and validated in `ical/url.ts`. */
const ICAL = /^\/ical(?:\s+(\S{1,2100}))?$/i;

const BIRTHDAY = /^\/(?:birthday|יומולדת)(?:\s+(.{1,120}))?$/i;
/** `מחק`/`הסר`/`remove`/`delete`, then the name. */
const BIRTHDAY_REMOVE = /^(?:מחק|הסר|remove|delete|off)\s+(.{1,60})$/i;
/** A trailing `14.3` or `14/3`. The name is whatever comes before it. */
const BIRTHDAY_DATE = /^(.{1,60}?)\s+(\d{1,2})[./](\d{1,2})$/;

function birthdayCommand(text: string): Command | null {
  const match = BIRTHDAY.exec(text);
  if (!match) return null;

  const argument = match[1]?.trim();
  if (!argument) return { kind: 'birthday', action: { kind: 'list' } };

  const removal = BIRTHDAY_REMOVE.exec(argument);
  if (removal?.[1]) return { kind: 'birthday', action: { kind: 'remove', name: removal[1].trim() } };

  const dated = BIRTHDAY_DATE.exec(argument);
  if (dated?.[1] && dated[2] && dated[3]) {
    return {
      kind: 'birthday',
      action: { kind: 'add', name: dated[1].trim(), day: Number(dated[2]), month: Number(dated[3]) },
    };
  }

  // `/birthday דנה` with no date is still recognisably this command, so it is
  // answered with the shape it should have taken. Falling through to the parser
  // would answer "not understood", which tells the user nothing they can use.
  return { kind: 'birthday', action: { kind: 'malformed' } };
}

/** Returns the command for a message, or null if it is free text. */
export function matchCommand(text: string): Command | null {
  const trimmed = text.trim();
  for (const [pattern, command] of COMMANDS) {
    if (pattern.test(trimmed)) return command;
  }

  const birthday = birthdayCommand(trimmed);
  if (birthday) return birthday;

  const ical = ICAL.exec(trimmed);
  if (ical) {
    const argument = ical[1];
    if (argument === undefined) return { kind: 'ical', set: null };
    return { kind: 'ical', set: /^off$/i.test(argument) ? 'off' : argument };
  }

  const digest = DIGEST.exec(trimmed);
  if (!digest) return null;

  const argument = digest[1];
  if (argument === undefined) return { kind: 'digest', set: null };
  if (/^off$/i.test(argument)) return { kind: 'digest', set: 'off' };

  const hour = Number(argument);
  // An hour outside the clock is not a command. Falling through to the parser
  // is better than clamping it to something the user did not ask for.
  return hour >= 0 && hour <= 23 ? { kind: 'digest', set: hour } : null;
}
