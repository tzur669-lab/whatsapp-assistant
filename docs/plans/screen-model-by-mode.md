# Screen agent: the conversation's model family, fallback inside it; cap 10/day

User decisions (2026-10-13): in a **smart** conversation the screen text may go
to Gemini (no consent card); in a **local** conversation it goes to Groq only.
Never cross families. Daily cap 3 → 10. The user also adds models to the
screen lists before their `eval:screen` reports are read (an override of
models.ts:152-158 and screen-agent.md:324, recorded in PLAN §14); code's risk
policy still stops every sensitive or uncertain tap.

## Changes

1. **Migration 0031** (`migrations/0031_screen_task_mode.sql`, registered in `src/platform/migrations.ts`):
   - `ALTER TABLE screen_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'local' CHECK (mode IN ('local','smart'))`.
   - `CREATE TABLE screen_model_day (principal, local_day, model, tokens, PRIMARY KEY (principal, local_day, model))`: screen tokens per Groq model per Jerusalem day.
2. **Mode reaches the task.** `ToolContext.smart?: true` (`src/tools/types.ts`). The pipeline's ToolContext builder (`src/core/pipeline.ts` ~:1655) sets it only when `smartWanted(event)` **and** `services.agent?.smartProviders?.length` — a smart conversation without Gemini already runs locally with a note (pipeline.ts:570-577), so its screen task is local too, never a doomed smart one.
3. **`src/tools/screen.ts`**: `screenInputSchema` gains `smart: z.literal(true).optional()`; `resolve` sets it from `ctx.smart` (never from the model's slots, `slotsSchema` is separate); the stored confirmed input carries it (invariant 7); `execute` passes `mode` to `store.create`. A confirmation stored before the deploy has no field → local. Rollback note: for 2 minutes after a rollback (`SCREEN_CLAIM_TTL_MS`) a pending input with `smart` fails the old strict schema — accepted, written in the deploy note.
4. **`src/tools/screen-store.ts`**: `create({ mode })`, `ScreenTask.mode`; `SCREEN_TASKS_PER_DAY` 3 → 10; `SCREEN_GROQ_DAY_TOKENS = 50_000` per Groq model; `groqDayTokens(principal, model)` and the add, written in the same call as `addTokens`. `registry.ts` `screen.task` rateLimit → `{ perHour: 10, perDay: 10 }`.
5. **`src/agent/models.ts`**:
   - `SCREEN_MODELS = [QWEN, GPT_OSS_120B]`.
   - `SCREEN_SMART_MODELS = [GEMINI_FLASH_LITE, GEMINI_FLASH]`. `gemini-3.5-flash` gets a full `ModelEntry` (`provider: 'gemini'`, `role: 'smart'`, `minuteTokens`, `charsPerToken`, `params` copied from the lite entry; `minuteRequests` 5, `dayRequests` 20) in a new screen-only table `SCREEN_ONLY_MODELS`, searched by `modelEntry()`, never in `MODELS` or `SMART_MODELS` (chat unchanged).
   - A per-entry `screenCompletionTokens`: Groq 150 (as now); Gemini 1024, **confirmed by a probe** (step 10) before commit, raised if the probe ends `length`.
6. **`src/agent/screen-step.ts`**:
   - `StepDeps.providersFor(mode)` replaces `providers`; the step uses `task.mode`'s list only.
   - Task ceiling by mode: Groq 18,000, Gemini 48,000.
   - A Groq candidate is skipped when `groqDayTokens + reserved > SCREEN_GROQ_DAY_TOKENS`: at most 50K of each Groq model's 200K/day goes to the screen, so chat keeps ≥150K on qwen and on gpt-oss.
   - A 429 (or 503/500) on a candidate: `budget.refused(...)` (`'unavailable'` for 503/500; a sent 500/503 is still charged via `chargeUnanswered` + `addTokens`, as now), then the **next candidate in the same step** (the action is not decided yet). The whole step shares one deadline of 25 s (`STEP_TIMEOUT_MS`), below `SCREEN_INFLIGHT_MS` 30 s, so a phone retry never runs a parallel call. Only when no candidate is left: the task ends `quota` if every model of the family is out **for the day** — `TokenBudget.isOutForDay(model)` (a remembered day flag set by a daily 429 or a `dayRequests` refusal, cleared at the quota day's turn; in memory, lost on eviction, accepted) or the Groq screen day cap (checked in screen-step.ts, not in `TokenBudget`) — else `waitOr` as now. A per-minute rest never ends a task as `quota`.
7. **`src/platform/assistant-do.ts` `screenStepDeps`**: local → `SCREEN_MODELS` via `createGroqAgentProvider` + `groqFetch`; smart → `SCREEN_SMART_MODELS` via `createGeminiAgentProvider` + `fetchImpl`, each with its entry's `params` and `screenCompletionTokens`. No Gemini key → empty list → ends `quota` (unreachable after step 2, kept as the safe floor).
8. **App** (`apps/call-companion`): `strings.xml:293` disclosure says screen text goes to Groq in a regular conversation and to Google Gemini (which may learn from it) in a smart one — Hebrew through the `hebrew-content-writer` skill. Version 0.14.2 (`versionCode`/`versionName` in the app's Gradle file, HANDOFF header), APK to Downloads. No protocol change, so no server/APK order.
9. **Eval harness** `test/evals/run-screen-evals.ts`: accept a `SCREEN_SMART_MODELS` id (Gemini provider, its completion cap, a request guard at 80% of `dayRequests`, fingerprint by model).
10. **Probe**: `pnpm eval:screen --model gemini-3.5-flash-lite` on a few cases, to confirm 1024 does not end `length`. Full screen evals on gpt-oss-120b and both Gemini models stay owed (PLAN §13) — they spend Groq's daily budget.
11. **Docs**: CLAUDE.md invariant 2; PLAN §6.28 (limits, models), §13 owed evals, §14 row (incl. the override); HANDOFF §1/§4/§6/§8; ARCHITECTURE.md:196; docs/plans/screen-agent.md:28, :213, :324.
12. **Tests first**: providers by mode never cross; next candidate on 429 in the same step; a per-minute rest ends `busy`/waits, never `quota`; day-out on both → `quota`; Groq day cap skips a model; Gemini completion cap; mode persisted; `ctx.smart` without smart providers → local; old input → local; cap 10 (`test/unit/tools/screen.test.ts:516` fixture). Update `gemini-provider.test.ts:326-341` (new table never in `MODELS`/`SMART_MODELS`), `fingerprint.test.ts:70` (include the new table).

Then typecheck/lint/test + app unit tests, commit, push. `deploy:staging` only with approval.

## Rejected objections

- Wait budget (6 waits) spent by Gemini rests: largely removed by trying the next candidate in the same step; the remaining case (both models resting) waiting up to 6 times then ending `busy` is accepted.
