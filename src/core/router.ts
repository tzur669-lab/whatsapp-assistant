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
  | { kind: 'connect_google' };

const COMMANDS: ReadonlyArray<readonly [RegExp, Command]> = [
  [/^\/help$|^עזרה$/i, { kind: 'help' }],
  [/^\/ping$/i, { kind: 'ping' }],
  [/^\/status$/i, { kind: 'status' }],
  [/^\/pause$/i, { kind: 'pause' }],
  [/^\/resume$/i, { kind: 'resume' }],
  [/^\/budget$/i, { kind: 'budget' }],
  [/^\/connect\s+google$/i, { kind: 'connect_google' }],
];

/** Returns the command for a message, or null if it is free text. */
export function matchCommand(text: string): Command | null {
  const trimmed = text.trim();
  for (const [pattern, command] of COMMANDS) {
    if (pattern.test(trimmed)) return command;
  }
  return null;
}
