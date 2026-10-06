/**
 * The model table (PLAN §6.19, 2026-10-06): every model the bot may call, in
 * failover order, and everything about each that code relies on.
 *
 * Static by design (invariant 8). The bot never discovers models at runtime; a
 * model not listed here is never called. `canWrite` is changed only by a
 * reviewed commit after a human has read the eval report (`pnpm eval:agent
 * --model <id> --select-tools`), and `evaluated.fingerprint` must match the
 * current one or the fingerprint test fails.
 *
 * Effective limits are the lower of the organization's and the key's Groq
 * project's, read once from the console and confirmed with a one-token probe
 * (PLAN §13).
 */

export type ModelRole = 'primary' | 'backup';

export type ModelEntry = {
  /** Fully versioned. No `-latest` aliases (unit test). */
  id: string;
  provider: 'groq';
  role: ModelRole;
  /** The effective tokens-per-minute bucket for this key's project. */
  minuteTokens: number;
  /** Sent as `max_completion_tokens`, and reserved in full before each call. */
  maxCompletionTokens: number;
  /** Request parameters this model accepts. Sent only when present. */
  params: { reasoningEffort?: 'low' };
  /** The most one agent turn may spend on this model. */
  turnCap: number;
  /** May run an agent turn that writes. Backups' writes still always confirm (§6). */
  canWrite: boolean;
  /** The environment the write gate was passed in (PLAN §6.19, "Failover and tokens"). */
  evaluated?: { fingerprint: string; date: string };
};

export const QWEN = 'qwen/qwen3.8-27b';
export const GPT_OSS_120B = 'openai/gpt-oss-120b';

export const MODELS: readonly ModelEntry[] = [
  {
    id: QWEN,
    provider: 'groq',
    role: 'primary',
    minuteTokens: 8_000,
    maxCompletionTokens: 1_024,
    params: { reasoningEffort: 'low' },
    turnCap: 7_000,
    // Passed the gate without selection (prompt v5, 2026-09-27). The run with
    // `--select-tools` sets `evaluated`; until then the fingerprint test warns
    // (PLAN §14). The primary must be able to write, or there is no agent.
    canWrite: true,
  },
  {
    id: GPT_OSS_120B,
    provider: 'groq',
    role: 'backup',
    minuteTokens: 8_000,
    maxCompletionTokens: 1_024,
    params: { reasoningEffort: 'low' },
    turnCap: 7_000,
    // Invents times as an agent (93% no-invented-slots, 2026-10-01). Read-only
    // until it passes the gate.
    canWrite: false,
  },
];

export function modelEntry(id: string): ModelEntry | undefined {
  return MODELS.find((entry) => entry.id === id);
}

/** The bucket this server assumes for a model it does not know. */
export const DEFAULT_MINUTE_TOKENS = 8_000;
export const DEFAULT_TURN_CAP = 7_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 1_024;
