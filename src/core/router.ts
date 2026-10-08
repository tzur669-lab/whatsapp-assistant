/**
 * Deterministic command routing. Anything matched here never reaches the LLM
 * (PLAN §6.4). Unmatched text falls through to NLU in a later phase.
 */
import { grantByCommand } from '../google/grants.js';
import type { GrantName } from '../google/grants.js';

export type Command =
  | { kind: 'help' }
  | { kind: 'ping' }
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'budget' }
  /** Wipe the agent's conversation history (PLAN §6.19). */
  | { kind: 'forget' }
  /** "לא הבנת": keep the latest exchange for review (§6.23). */
  | { kind: 'missed' }
  /** `/misses`: show what was kept (§6.23). */
  | { kind: 'misses' }
  /** `/memory`: the facts kept about the user (§6.26). */
  | { kind: 'memory' }
  /** `/forget memory`: forget every fact (§6.26). `/forget` alone keeps them. */
  | { kind: 'forget_memory' }
  /** `/consents`: what this smart conversation allowed, each revocable (2026-10-08). */
  | { kind: 'consents' }
  /** `/connect google|gmail|tasks|drive`: one grant each (§6.6, 2026-10-01). */
  | { kind: 'connect_google'; grant: GrantName }
  /** `/pair` issues a code for the phone app; `/pair off` unpairs (PLAN §6.17). */
  | { kind: 'pair'; off: boolean }
  /**
   * `/digest`, `/digest 7`, `/digest off` (PLAN §6.12). The only command that
   * carries a value, so it is matched separately from the fixed table below.
   */
  | { kind: 'digest'; set: number | 'off' | null }
  /** `/shabbat`, `/shabbat on`, `/shabbat off` (PLAN §6.13). Off by default. */
  | { kind: 'shabbat'; set: boolean | null }
  /** `/city`, `/city <name>`: the home city for weather and Shabbat times (2026-10-01). */
  | { kind: 'city'; set: string | null }
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
  [/^\/forget$/i, { kind: 'forget' }],
  [/^\/forget\s+memory$/i, { kind: 'forget_memory' }],
  [/^\/memory$/i, { kind: 'memory' }],
  [/^\/consents$/i, { kind: 'consents' }],
  [/^\/shabbat$/i, { kind: 'shabbat', set: null }],
  [/^\/shabbat\s+on$/i, { kind: 'shabbat', set: true }],
  [/^\/shabbat\s+off$/i, { kind: 'shabbat', set: false }],
  [/^\/pair$/i, { kind: 'pair', off: false }],
  [/^\/pair\s+off$/i, { kind: 'pair', off: true }],
];

const DIGEST = /^\/digest(?:\s+(off|\d{1,2}))?$/i;

/** The argument is a URL, so it is captured loosely here and validated in `ical/url.ts`. */
const ICAL = /^\/ical(?:\s+(\S{1,2100}))?$/i;

const CONNECT = /^\/connect\s+(google|gmail|tasks|drive)$/i;

const CITY = /^\/(?:city|עיר)(?:\s+(.{1,60}))?$/i;

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

/**
 * "לא הבנת" as the whole message, after punctuation and spaces (§6.23). A
 * longer message ("לא הבנת, התכוונתי למחר") is a correction for the agent.
 */
const MISSED = /^(?:לא הבנת(?: אותי)?|\/missed)$/i;
const MISSES = /^\/misses$/i;

function bareCommand(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns the command for a message, or null if it is free text. */
export function matchCommand(text: string): Command | null {
  const trimmed = text.trim();
  const bare = bareCommand(trimmed);
  if (MISSED.test(bare)) return { kind: 'missed' };
  if (MISSES.test(bare)) return { kind: 'misses' };
  for (const [pattern, command] of COMMANDS) {
    if (pattern.test(trimmed)) return command;
  }

  const birthday = birthdayCommand(trimmed);
  if (birthday) return birthday;

  const connect = CONNECT.exec(trimmed);
  if (connect?.[1]) {
    const grant = grantByCommand(connect[1]);
    return grant ? { kind: 'connect_google', grant } : null;
  }

  const city = CITY.exec(trimmed);
  if (city) {
    const name = city[1]?.trim();
    return { kind: 'city', set: name ? name : null };
  }

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
