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

/**
 * `smart` (2026-10-08): a model only a smart conversation may use. It is never
 * `primary`, so every write it proposes confirms (§6), and it lives in
 * `SMART_MODELS`, never in `MODELS`, so no local conversation reaches it.
 */
export type ModelRole = 'primary' | 'backup' | 'smart';

export type ModelProvider = 'groq' | 'gemini';

export type ModelEntry = {
  /** Fully versioned. No `-latest` aliases (unit test). */
  id: string;
  provider: ModelProvider;
  role: ModelRole;
  /** The effective tokens-per-minute bucket for this key's project. */
  minuteTokens: number;
  /** Sent as the completion size, and reserved in full before each call. */
  maxCompletionTokens: number;
  /** Request parameters this model accepts. Sent only when present. */
  params: { reasoningEffort?: 'low' };
  /** The most one agent turn may spend on this model. */
  turnCap: number;
  /** The most model calls one agent turn may make on this model. */
  maxModelCalls: number;
  /** Characters per token for this model's estimates (measured; `budget.ts`). */
  charsPerToken: number;
  /** Requests per minute, for a provider that limits them. Absent: tokens only. */
  minuteRequests?: number;
  /** Requests per quota day (Pacific midnight), for a provider that limits them. */
  dayRequests?: number;
  /** May run an agent turn that writes. Backups' writes still always confirm (§6). */
  canWrite: boolean;
  /**
   * The environment the write gate was passed in (PLAN §6.19, "Failover and tokens"),
   * and `judging`: what the pass was judged by (2026-10-12). The fingerprint test
   * requires `judging` on every recorded entry; a mismatch is re-scored for free.
   */
  evaluated?: { fingerprint: string; date: string; judging?: string };
};

/**
 * Groq's measured characters per token (2026-10-07,
 * `test/fixtures/token-calibration.json`). `budget.ts` explains the number and
 * re-exports it as `CHARS_PER_TOKEN`.
 */
export const GROQ_CHARS_PER_TOKEN = 3.0;

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
    maxModelCalls: 3,
    charsPerToken: GROQ_CHARS_PER_TOKEN,
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
    maxModelCalls: 3,
    charsPerToken: GROQ_CHARS_PER_TOKEN,
    // Invents times as an agent (93% no-invented-slots, 2026-10-01). Read-only
    // until it passes the gate.
    canWrite: false,
  },
];

export const GEMINI_FLASH_LITE = 'gemini-3.5-flash-lite';

/**
 * Models only a smart conversation may use (2026-10-08). Never in `MODELS`, so
 * never in a local conversation's `providers` or `fallbackProviders` (unit
 * test: the two tables never overlap). Only a smart conversation's own words
 * reach them (`pipeline.ts`, `loop.ts`).
 */
export const SMART_MODELS: readonly ModelEntry[] = [
  {
    // A stable, versioned id with no `-latest`. `gemini-2.5-flash` closed to
    // new users (404 "no longer available to new users", live probe
    // 2026-10-08). `gemini-3.5-flash` answered, but its free tier stopped
    // after about 25 requests that day (agent eval, 2026-10-08), too few for
    // daily use, so the user chose 3.5 Flash-Lite (2026-10-08): a probe
    // answered 200 in about 1–2 s. 3.7 and 3.8 Flash often answered 503 "high
    // demand" that day: revisit them. Gemini 3 sends a thought signature with
    // each tool call, Flash-Lite included, sent back by the provider.
    id: GEMINI_FLASH_LITE,
    provider: 'gemini',
    role: 'smart',
    // Placeholders, not measured: the free tier's real limits are read in AI
    // Studio and confirmed with a probe (PLAN §13). 15 a minute and 500 a day
    // are conservative guesses (2026-10-08). If Google's limit is lower, its
    // 429 rests the model and the turn goes on to qwen; the eval's guard
    // stops a run at 80% of `dayRequests`.
    minuteTokens: 250_000,
    minuteRequests: 15,
    dayRequests: 500,
    maxCompletionTokens: 4_096,
    // Gemini's compatible endpoint takes `reasoning_effort`. Gemini 3 thinks
    // inside `max_tokens`: unbounded, a small budget ended `length` with an
    // empty message (probe, 2026-10-08). `low` keeps the thinking short.
    params: { reasoningEffort: 'low' },
    turnCap: 60_000,
    maxModelCalls: 6,
    // Groq's measured rate until a Gemini calibration exists (PLAN §13).
    charsPerToken: GROQ_CHARS_PER_TOKEN,
    // Read-only until a human has read its eval report (PLAN §6.19).
    canWrite: false,
  },
];

export const GEMINI_FLASH = 'gemini-3.5-flash';

/**
 * Models only the screen agent may use (2026-10-13), never a chat turn: not in
 * `MODELS` or `SMART_MODELS` (unit test). Gemini 3.5 Flash is a smart screen
 * task's second model, after Flash-Lite. Its free tier stopped after about 25
 * requests on 2026-10-08, so its day is capped at 20; everything else is
 * Flash-Lite's, unmeasured too (PLAN §13).
 */
export const SCREEN_ONLY_MODELS: readonly ModelEntry[] = [
  {
    id: GEMINI_FLASH,
    provider: 'gemini',
    role: 'smart',
    minuteTokens: 250_000,
    minuteRequests: 5,
    dayRequests: 20,
    maxCompletionTokens: 4_096,
    params: { reasoningEffort: 'low' },
    turnCap: 60_000,
    maxModelCalls: 6,
    charsPerToken: GROQ_CHARS_PER_TOKEN,
    canWrite: false,
  },
];

/** Every table: a smart or screen model found by id gets its own limits, never qwen's defaults. */
export function modelEntry(id: string): ModelEntry | undefined {
  return (
    MODELS.find((entry) => entry.id === id) ??
    SMART_MODELS.find((entry) => entry.id === id) ??
    SCREEN_ONLY_MODELS.find((entry) => entry.id === id)
  );
}

/** The bucket this server assumes for a model it does not know. */
export const DEFAULT_MINUTE_TOKENS = 8_000;
export const DEFAULT_TURN_CAP = 7_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 1_024;

/**
 * The models a screen-agent step may use, by the conversation the task was
 * confirmed in (PLAN §6.28; the user's decision, 2026-10-13). A local task asks
 * only Groq (`SCREEN_MODELS`), a smart one only Gemini
 * (`SCREEN_SMART_MODELS`): screen text from a local conversation never reaches
 * Gemini, and a task never crosses. In each list the next model is asked when
 * the one before is out. Groq quotas are per model; each Groq model gives the
 * screen at most `SCREEN_GROQ_DAY_TOKENS` a day, so chat keeps the rest. The
 * user added gpt-oss-120b and both Gemini models before their
 * `pnpm eval:screen` reports were read (2026-10-13, PLAN §14); code's risk
 * policy still stops every sensitive or uncertain tap.
 */
export const SCREEN_MODELS: readonly string[] = [QWEN, GPT_OSS_120B];
export const SCREEN_SMART_MODELS: readonly string[] = [GEMINI_FLASH_LITE, GEMINI_FLASH];

/**
 * The models that draft a routine from the user's words and the app's first
 * screen (docs/plans/routine-builder.md), by the conversation the draft was
 * confirmed in, never crossing: Groq for a local one, Gemini Flash-Lite only
 * for a smart one — never Flash, whose 20 a day are the screen agent's. Groq
 * tokens count against the screen's day share (`SCREEN_GROQ_DAY_TOKENS`).
 */
export const DRAFT_MODELS: readonly string[] = [QWEN, GPT_OSS_120B];
export const DRAFT_SMART_MODELS: readonly string[] = [GEMINI_FLASH_LITE];

/**
 * The models that may read an image (PLAN §6.32), in every conversation. The
 * user's Groq key has no vision model, so the user chose (2026-10-14) that
 * Gemini reads every image, regular conversations included: only the image
 * goes to it, for one read with no tools; the text it read is shared text and
 * runs on the conversation's own models. Gemini's free tier may train on what
 * it gets, so the first image is answered with a notice saying so. Not Gemini
 * 3.5 Flash: its 20 a day are the screen agent's.
 */
export const VISION_MODELS: readonly string[] = [GEMINI_FLASH_LITE];
