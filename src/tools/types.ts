/**
 * The `ToolDefinition` contract (PLAN §6.4).
 *
 * Three stages, deliberately separate:
 *
 *   resolve   slots from the LLM  -> a complete, validated input, or a question
 *   preview   input               -> a code-rendered summary for a confirmation
 *   execute   input               -> the action, and the reply
 *
 * `resolve` is where all the judgment lives, and it is pure code: it computes
 * times, finds targets, and refuses to fill a gap the user left. `execute` gets
 * something that is already known-good.
 *
 * Inputs cross a **JSON boundary** between the two whenever a confirmation is
 * involved: the input is stored, the user taps a button minutes later, and the
 * row comes back as `unknown`. So every `execute` re-validates its own input
 * against a Zod schema. The stored hash already guards against tampering; this
 * guards against everything else, and it is what makes the erased types here
 * honest rather than a cast.
 */
import type { ZodTypeAny } from 'zod';
import type { Lang } from '../render/format-time.js';
import type { ClarifyTime } from '../time/resolve.js';
import type { ToolName } from './registry.js';
import type { ReminderStore } from './reminder-store.js';
import type { Repository } from '../core/repo.js';
import type { Logger } from '../security/redact.js';

/** One candidate when a description matched more than one thing. */
export type TargetChoice = { id: string; label: string };

/**
 * Why a tool cannot proceed. Stable codes only — the wording lives in
 * `src/render/`, so a question can be asked in either language from one place.
 */
export type Clarify =
  /** The user did not say something the tool cannot invent (PLAN §6.3 R11). */
  | { code: 'missing_slot'; slot: 'text' | 'time' | 'target' | 'title' | 'date' }
  /** The time resolver returned a question. Carries its rule and suggestion. */
  | { code: 'time'; detail: ClarifyTime }
  /** Nothing matched the description the user gave. */
  | { code: 'not_found' }
  /** Several things matched. The user picks by number or button. */
  | { code: 'ambiguous'; choices: TargetChoice[] }
  /** The request was well-formed but there is nothing to act on. */
  | { code: 'nothing_scheduled' }
  /** Google is not connected yet. */
  | { code: 'not_connected' };

export type ResolveOutcome =
  | {
      kind: 'ready';
      /** Validated and complete. Safe to store and to execute later. */
      input: unknown;
      /** R8: far-future writes execute only after a confirmation. */
      needsConfirm?: boolean;
    }
  | { kind: 'clarify'; clarify: Clarify };

export type ToolContext = {
  principal: string;
  nowMs: number;
  lang: Lang;
  repo: Repository;
  reminders: ReminderStore;
  log: Logger;
  /** Start of the 24-hour window, for planning a reminder's delivery (§6.7). */
  lastInboundAt: number | null;
  /** Service messages used this month, for the same decision (§5). */
  monthlySent: number;
};

export type ExecuteResult = {
  /** The reply. Code-rendered — the LLM never writes one (invariant 1). */
  text: string;
  /**
   * Tier 1 only: what an Undo would run, stored at execution time. A
   * compensating action written down now, never a re-reading of the request
   * later (PLAN §6.5).
   */
  compensating?: unknown;
  /** An id for the audit log. Never content. */
  externalRef?: string;
  /** Set when the action changed when the next alarm should fire. */
  rescheduleAlarm?: boolean;
};

export interface ToolDefinition {
  name: ToolName;
  /** Re-validated before every execute, including after a confirmation. */
  inputSchema: ZodTypeAny;
  resolve(slots: unknown, ctx: ToolContext): ResolveOutcome;
  preview(input: unknown, lang: Lang): string;
  execute(input: unknown, ctx: ToolContext): Promise<ExecuteResult>;
  /** Present only on Tier 1 tools, which execute first and offer a way back. */
  undo?(compensating: unknown, ctx: ToolContext): Promise<ExecuteResult>;
}

/** Thrown when a stored input no longer matches its tool's schema. */
export class ToolInputError extends Error {
  constructor(readonly tool: string) {
    super('E_TOOL_INPUT_INVALID');
    this.name = 'ToolInputError';
  }
}

/** Parse a stored or freshly resolved input, or refuse to run. */
export function parseInput<T>(schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }, value: unknown, tool: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolInputError(tool);
  return parsed.data as T;
}
