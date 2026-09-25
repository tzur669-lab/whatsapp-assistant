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
  | { kind: 'shabbat'; set: boolean | null };

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

/** Returns the command for a message, or null if it is free text. */
export function matchCommand(text: string): Command | null {
  const trimmed = text.trim();
  for (const [pattern, command] of COMMANDS) {
    if (pattern.test(trimmed)) return command;
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
