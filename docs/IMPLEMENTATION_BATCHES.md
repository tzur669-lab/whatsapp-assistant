# Implementation Batches

The execution order for `docs/IMPROVEMENT_PLAN.md`, the evidence and design reference. This file says
**what to do in which session**. The plan says **why**, and gives the evidence. References like
"Plan §3 T1" point there.

## How to use this file

- Work happens one **batch** per coding session. A batch normally holds **two** small tasks.
- Give the agent the template below with a batch number. It executes **only that batch**.
- Batches are ordered by dependency. Do not start a batch whose "Depends on" or "Blocked by" is open.
- Each batch ends green: `pnpm typecheck && pnpm lint && pnpm test`, plus the batch's own checks.
  Android batches also need `cd apps/call-companion && ./gradlew testDebugUnitTest`.
- Every batch can run in a fresh session. The "Carry forward" line says what the next session needs
  to know. The repository and this file carry everything else.
- CLAUDE.md still applies:
  - test first in `src/agent/`, `src/security/`, `src/policy/`, `src/confirm/`;
  - `pnpm eval:agent --filter …` after a change to an agent prompt, catalog or provider;
  - a PLAN §14 line when behaviour changes;
  - HANDOFF/ARCHITECTURE when modules or coupling change (the docs-guard hook);
  - staging deploys only with explicit approval; production never by the agent;
  - no commit unless asked.
- **Unit tests do not prove** provider behaviour, account settings or real-phone behaviour. Tasks
  that need those say so, under **Manual / live / device**.

### Instruction template

> Execute Batch NN only from `docs/IMPLEMENTATION_BATCHES.md`. Inspect the relevant source and the referenced sections of `docs/IMPROVEMENT_PLAN.md`. Implement only the two tasks in that batch, add and run the required tests, and report changed files, test results, unresolved issues, and whether the batch's acceptance criteria are met. Do not start any task from another batch. Do not commit unless explicitly asked.

## Decisions that belong to the user

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| D1 | Should a "this time" approval's reply stay in the smart history for follow-ups (today), or become a placeholder? | Placeholder — **decided 2026-10-12: placeholder** (Batch 03's filter already does it; T1-4 adds its test and docs) | T1-4 |
| D2 | At T1 deploy, accept losing up to 12 h of smart-conversation context once, since legacy entries are replayed as placeholders? | Yes — **decided 2026-10-12: yes** | T1-2 |
| D3 | How many days to keep delivered or cancelled reminders (and old audit rows)? | — | T11-1 (optional) |
| D4 | Keep the regular mode's label "local", explained by its note, or rename it? | Rename | the label part of T6b-1 (the note text is not blocked) |

**Before Batch 01:** no decision is needed. Batches 01–02 are decision-free.
**Before Batch 03:** D2. **Before Batch 04:** D1. **Before Batch 09:** D4.

## Manual, live and device work (not coding tasks)

| ID | What | Who | Needed by |
|---|---|---|---|
| M1 | Account checks (Plan §3 T6): Groq on the free tier, ZDR toggle available and on; Gemini project with no billing linked; Cloudflare on Workers Free; Finnhub free key; for each configured model id, whether it is production/stable or preview. | User | T6-1 (Batch 10) |
| M2 | A full `pnpm eval:agent --model qwen/qwen3.8-27b --select-tools` run with a human read. It is resumable and may span days (200K tokens per day per model). | User runs it, or approves the agent running it | T2-5 (Batch 10) |
| M3 | Staging deploy after Batch 08's server task, before any APK with `field_changed`. | User approves `pnpm deploy:staging` | Batch 09 |
| M4 | Physical-phone checks (Plan §6, "Physical Android device"): the FID routine unchanged; an anchored field losing focus or disappearing; a non-editable launcher; TAP → WAIT → TYPE. | User, with the agent's checklist | T4-3 (Batch 09) |
| M5 | Staging smart-conversation check after Batch 04: allow calendar, ask, revoke with `/consents`, follow up. | User | after Batch 04 |
| M6 | A week of staging use, then read the `agent_turn` records to confirm or raise the 60 s deadline (Plan §3 T3). | User + agent | after Batch 06; review before production |

---

## Required work (P1/P2)

### Batch 01: honest eval runner (P1)

Order: T2-1, then T2-2. They are independent, but both touch the eval scripts.

**T2-1: exit codes, no vacuous passes, fingerprint only after a pass**
- Purpose:
  - A threshold miss exits 0 today.
  - An empty gate passes (`ratio` returns 1 on 0 cases).
  - A fingerprint is printed even after a failed run.
- Scope: `test/evals/run-agent-evals.ts`.
- Depends on: none.
- Acceptance:
  - Exit 1 on a hard-gate miss (any run, gates with cases). Exit 1 on a soft-metric miss in a
    complete, unfiltered, unsampled run.
  - Exit 2 on an incomplete run: ledger or `daily_budget` stop, `--sample`, `--report` without a
    complete recording.
  - Exit 0 otherwise.
  - Every gate prints its case count. A zero-case gate prints `n/a (0 cases)` and blocks exit 0
    and eligibility.
  - The fingerprint (and, from T2-3, `judging`) is printed only after a complete pass.
  - `p95LatencyMs` is a warning only.
- Tests and checks: `pnpm typecheck && pnpm lint && pnpm test`. Exercise the exit paths with
  `--report --resume` against a crafted recording file, which needs no provider calls.
- Completion boundary: exit behaviour verified for the pass, hard-miss, zero-case and
  budget-stopped recordings.
- Plan ref: §3 T2 steps 1–3.

**T2-2: model identity in the fingerprint; the recording records its environment**
- Purpose: a model id or provider swap would inherit an old `evaluated`. A re-score must not use a
  recording from a different environment.
- Scope: `test/evals/fingerprint.ts` (`fingerprintFor`, `smartFingerprintFor`),
  `test/evals/run-agent-evals.ts` (the recording shape), `test/unit/agent/fingerprint.test.ts`.
- Depends on: none.
- Acceptance:
  - Both fingerprints include `entry.id` and `entry.provider`.
  - A new recording stores its fingerprint, plus the response's `model` field and a
    `system_fingerprint` if the provider returns one. Check this on one real response before
    relying on it.
  - `--report --resume` refuses a recording whose stored fingerprint differs from the current one.
- Tests and checks: a unit test shows that changing `id` or `provider` changes the fingerprint.
  Full suite green.
- Completion boundary: no entry records `evaluated` today, so no recorded value changes. State this
  in the report.
- Plan ref: §3 T2 step 4a.
- Carry forward: the recording format changed. Older recordings without a fingerprint cannot be
  re-scored; they need a new run when one is next needed.

### Batch 02: enforceable release gate (P1)

Order: T2-3, then T2-4.

**T2-3: `judging` hash enforced, with a free re-score**
- Purpose: a tighter threshold or a changed expectation leaves an old pass looking valid.
- Scope:
  - `test/evals/fingerprint.ts` or a new helper: hash of every case's `expect`, the scoring source
    and `THRESHOLDS`;
  - `src/agent/models.ts`: the `evaluated` type gains an optional `judging`;
  - `test/unit/agent/fingerprint.test.ts`.
- Depends on: T2-1, T2-2.
- Acceptance:
  - `fingerprint.test.ts` fails when an entry's `evaluated.judging` differs from the current hash.
  - The failure message names the remedy: `pnpm eval:agent --model <id> --select-tools --report --resume`,
    then update `judging` if it passes.
- Tests and checks: a unit test shows a `THRESHOLDS` change flips the hash. Full suite green.
- Completion boundary: the remedy is documented in the test message. It makes no provider calls.
- Plan ref: §3 T2 step 4.

**T2-4: deploy-time check, production config test, runbook gate**
- Purpose: refuse a staging deploy from a tree whose write gate is stale, and refuse
  `AGENT=on` in production config without an evaluated primary.
- Scope:
  - `package.json`: `deploy:staging` runs the fingerprint test file first, then
    `wrangler deploy --env staging`. The script name is unchanged.
  - New `test/unit/config/release-gate.test.ts`, which reads `wrangler.jsonc`.
  - `ops/runbook.md`: a "Release gate" section.
- Depends on: T2-3.
- Acceptance:
  - A failing fingerprint test aborts `pnpm deploy:staging` before wrangler runs. Verify by running
    only the script's test part: **no actual deploy**.
  - The config test fails if production `AGENT` is `"on"` and the primary has no matching
    `evaluated`.
  - The runbook states which gates are enforced and which stay manual: live `--filter` evals,
    server before APK, production deploys.
- Tests and checks: full suite green.
- Completion boundary: the primary branch of `fingerprint.test.ts` still **warns** when `evaluated`
  is absent. It becomes strict only in T2-5.
- Plan ref: §3 T2 steps 5–6.
- Carry forward: the primary's warning-to-failure flip is T2-5, after M2.

### Batch 03: consent provenance in history (P1)

Order: T1-1, then T1-2. **Blocked by D2** (T1-2).

**T1-1: provenance tag on history entries (write side only)**
- Purpose: record which consent sources a stored reply may carry, including data inherited from
  history the model saw.
- Scope:
  - `src/agent/history.ts`: an optional `src` in the serialised entry and in `HistoryEntry`;
  - `src/core/pipeline.ts` `settleAgentResult`: provenance = this turn's non-public,
    non-`echoesOwnInput` tool sources ∪ the `src` of the entries replayed in full.
- Depends on: none.
- Acceptance:
  - New entries carry `src`.
  - A tool-less follow-up inherits the `src` of the history it saw.
  - Own-input writes add no source.
  - Old entries without `src` still decode.
  - **No change yet** to what is replayed.
- Tests and checks: test first in `test/unit/agent/`. Full suite green, log canaries green.
- Completion boundary: the tag is stored and covered by tests. The replay is untouched.
- Plan ref: §3 T1 step 1.

**T1-2: replay filter by current consent; legacy entries redacted (smart only)**
- Purpose: after a revoke, earlier replies from that source, and anything derived from them, must
  not reach a model again.
- Scope: `src/core/pipeline.ts`, right after the history read, where the grants are already
  computed.
- Depends on: T1-1. **Blocked by D2.**
- Acceptance:
  - In a smart conversation, an entry whose `src` contains a source no longer in
    `consents.list(...)` is replayed with `he.withheldPlaceholder`.
  - A legacy untagged entry is replayed with the user side intact and the reply as the placeholder.
  - Local conversations are unchanged.
  - `loop.ts` is unchanged.
- Tests and checks, through `seenByModel` in `test/integration/fake-agent.ts`:
  - revoke → placeholder;
  - read → tool-less follow-up repeating the title → revoke → both entries are placeholders;
  - legacy entry: placeholder in a smart conversation, unchanged in a local one;
  - own-input reply still replayed after a calendar revoke.
  - Full suite green.
- Completion boundary: the tests pass. A PLAN §14 line is added.
- Plan ref: §3 T1 step 2, Limits, Risks.
- Carry forward: resumed suspended turns are still unfiltered until T1-3.

### Batch 04: consent on resume and "this time" (P1)

Order: T1-3, then T1-4. **Blocked by D1** (T1-4).

**T1-3: a resumed turn ends if any data it would resend comes from a revoked source**
- Purpose:
  - A suspended state stores the whole message list: the replayed history **and this turn's earlier
    tool results** (`paused()`, `loop.ts:717-726`).
  - Both resume paths resend it (`loop.ts:535`, `:608`), while only tools are re-checked.
  - So a calendar read made before a mail-consent suspension reaches the model on resume, even if
    calendar was revoked meanwhile.
- Scope:
  - `src/agent/turns.ts`: an optional `historySources` in the strict `stateSchema`;
  - `src/agent/loop.ts`: `paused()` stores `historySources`, and one helper serves both resume
    paths. The helper computes `historySources` ∪ the sources of this turn's tools, from
    `ranIn(state.messages.slice(0, -1))` via `consentSourceOf`, excluding public and
    `echoesOwnInput`. If any is not allowed now (current grants ∪ the state's `once` ∪ the
    just-approved source), it returns the existing `failed('model_unavailable')`.
  - A legacy **smart** state without `historySources` also ends. Legacy local states resume as
    today.
- Depends on: T1-1.
- Acceptance: Plan §3 T1 tests **s1–s6**. Every check inspects what the fake model actually received
  (`seenByModel`). s1 must fail if any canary from a revoked source reaches the model.
- Tests and checks: test first in `test/unit/agent/`. Full suite green, log canaries green.
- Completion boundary:
  - s1–s6 pass.
  - PLAN §14 records the reject-not-redact choice and the legacy handling.
  - The rollback note is there too: an old build refuses a state with the new field
    (`E_AGENT_STATE`), affecting at most 3 min of in-flight turns.
- Plan ref: §3 T1 step 3; §5 T1 rollback.

**T1-4: "this time" semantics per D1, and the docs that state the boundary**
- Purpose: make the code, the comment and PLAN agree on what a one-time approval keeps.
- Scope:
  - If **D1 = placeholder:** `settleAgentResult` marks `once` sources so that such entries are never
    replayed in full.
  - Either way: the `src/agent/consents.ts` header comment; PLAN §6.19 / §7.1 / §14; HANDOFF §4.
- Depends on: T1-2. **Blocked by D1.**
- Acceptance:
  - With D1 = placeholder: after a `once` mail read, the next turn sees the placeholder, and a
    follow-up carries no `mail` provenance.
  - The docs describe the boundary: one tool read, visible to that turn's single model for the rest
    of that turn, possibly in several calls. Never "sent once".
- Tests and checks: full suite green; the docs-guard hook satisfied.
- Completion boundary: the code, the comment, PLAN and HANDOFF are consistent.
- Plan ref: §3 T1 steps 4–5; §7 D1.
- Carry forward: M5 can now be done.

### Batch 05: no free text in `errorCode` (P2)

Order: T5-1, then T5-2.

**T5-1: fix the three sources; canary through the generic catch sites; tripwire**
- Purpose: `orchestrator.ts:240, 592, 636` log `error.message`.
- Scope: `src/core/orchestrator.ts`; a canary test in `test/security/`; `test/security/banlist.test.ts`.
- Depends on: none.
- Acceptance:
  - The three sites log `error.name`, or a known class's code.
  - A fake tool throwing a canary-message `Error` in `resolve`, `execute`, confirmed execute and
    `undo` never reaches the log sink.
  - The ban-list test refuses `errorCode:` followed by `.message`. This is a tripwire only.
- Tests and checks: test first. Full suite green.
- Completion boundary: the canary covers all three sites.
- Plan ref: §3 T5 steps 1–2.

**T5-2: logger backup check, header comment, `seen` fix**
- Purpose: catch an obvious `errorCode` accident at the sink; correct a false comment; stop
  dropping shared objects.
- Scope: `src/security/redact.ts`; `test/unit/security/redact.test.ts`.
- Depends on: none.
- Acceptance:
  - A non-string, over-64-character, whitespace or non-ASCII `errorCode` becomes `E_UNCLASSIFIED`.
  - The header says it is a denylist, with no phone hashing.
  - A shared object is logged in full each time; a real cycle is still `[circular]`.
- Tests and checks: test first. Full suite green.
- Completion boundary: as above.
- Plan ref: §3 T5 steps 3–5.

### Batch 06: turn deadline, its outcome and its bounds (P2)

Order: T3-1, then T3-2.

**T3-1: deadline checks in the loop and a `deadline` outcome with no fallback**
- Purpose:
  - No turn may run unbounded.
  - A deadline must not lead to another model call or to a parsed write. Reusing `max_calls` would
    let the parser fallback run (`pipeline.ts:~585-597`).
- Scope:
  - `src/agent/loop.ts`: `TURN_DEADLINE_MS` = 60 s, provisional; `now()` in `AgentDeps`; checks at
    the top of the `while` loop and before `act()`; on expiry, release `loop.reserved` and return
    `failed('deadline')`.
  - `src/core/pipeline.ts`: `deadline` in `TURN_SHAPE_FAILURES`; `respondWithModels` returns
    `he.agentFailed('deadline')` at once, with no parser and no read-only try, and marks the
    outcome `E_AGENT_DEADLINE`.
  - The reply text is the existing default branch of `he.agentFailed`. No new Hebrew.
- Depends on: none.
- Acceptance: after the deadline no model call of any kind starts. A write whose `execute` started
  before the deadline answers with its own reply.
- Tests and checks: test first, with a fake clock, fake tools, fake NLU and a fake read-only
  provider. Boundary cases from Plan §3 T3 "Tests":
  - **(a)** W3;
  - **(b)** the model's write call after the deadline: no `execute`, and the NLU and read-only
    fakes are never called;
  - **(d)** R2;
  - **(e)** W4 pinned.
  - Full suite green.
- Completion boundary: (a), (b), (d) and (e) pass. (c), (c2), (d2) and (f) wait for T3-4.
- Plan ref: §3 T3 step 1, step 3b.

**T3-2: content-free timing record, and the lock TTL derived from the deadline**
- Purpose: validate the provisional 60 s against real turns, and make sure no operation of a turn
  outlives its lock.
- Scope:
  - The end of the agent loop: one `agent_turn` record (`ms`, `modelCalls`, `toolsRun`,
    `deadlineHit`; numbers and booleans only, through the redacting logger, resumes included).
  - `src/agent/lock.ts` plus a shared constants module: `MAX_WRITE_MS` from an enumeration, written
    in a comment, of the Tier 0–1 network writes. One `GoogleApi.call` takes up to 40 s with the
    refresh and the 401 retry.
  - `LOCK_TTL_MS ≥ TURN_DEADLINE_MS + MAX_WRITE_MS + margin`, about 180 s.
- Depends on: T3-1.
- Acceptance: the record is emitted on every loop exit path. The relation test passes. In boundary
  case (a) the lock is still held when the write finishes.
- Tests and checks: the log canaries stay green; a field-set test; the relation test. Full suite
  green.
- Completion boundary: the enumeration is written down with file references.
- Plan ref: §3 T3 step 1, "Validation"; step 4.
- Carry forward: start M6. T8-1 (optional) is now unblocked.

### Batch 07: cancel reads and model calls at the deadline (P2)

Order: T3-3, then T3-4. T3-4 relies on the signal T3-3 provides.

**T3-3: turn `AbortSignal` plumbing for model calls and read fetches**
- Purpose: one read can chain about 11 requests. Only a signal makes the deadline real at the
  network boundary.
- Scope:
  - `src/agent/provider.ts`;
  - `src/tools/types.ts`: an optional `signal` on the resolve-phase context;
  - `src/google/api.ts` (`call`, and the refresh through `token()`);
  - `src/google/oauth.ts`, `src/ical/fetch.ts`, `src/lookup/http.ts`, `src/lookup/quotes.ts`.
  - Each request combines the turn signal with its own timeout via `AbortSignal.any`.
  - **`execute` never receives it.**
- Depends on: T3-1.
- Acceptance:
  - A hung 3rd calendar request and a hung token refresh are aborted when the signal fires.
  - A grep test asserts that every read-path `fetch` takes the signal.
- Tests and checks: test first. Full suite green. `pnpm eval:agent --filter <one existing prefix,
  e.g. rm->`, because `provider.ts` changed (CLAUDE.md). That spends quota, so keep it small.
- Completion boundary: plumbing and the grep test only. Classifying the outcome is T3-4.
- Plan ref: §3 T3 step 2.

**T3-4: classify deadline outcomes: model calls, write tools, reads**
- Purpose: an abort caused by the deadline must end as `deadline`, never as an ordinary provider
  failure. No write may start after the deadline, and no aborted read may be shown as data.
- Scope:
  - `src/agent/loop.ts`: after `provider.complete` returns any error, if the turn signal fired,
    return `failed('deadline')`, whatever the provider's code (`timeout`/`network_error` today,
    `provider.ts:148-155`).
  - In `act()`, for reads only: if the signal had fired when the tool returned, discard its result
    (R1/R3) and end `failed('deadline')` with `toolRan: true` and no `readText`.
  - `src/core/orchestrator.ts`: check the signal **after resolve returns** and **immediately before
    `tool.execute`**. If it fired, reply `he.agentFailed('deadline')` with audit outcome `deadline`,
    and do not execute (W1, W2).
  - Confirm cards and an `execute` already running (W3) are untouched.
- Depends on: T3-3.
- Acceptance: the boundary cases from Plan §3 T3 "Tests":
  - **(c)** W1: resolve in flight;
  - **(c2)** W2: resolve completes 1 ms late;
  - **(d2)** R1/R3: replies `he.agentIncomplete`, with no data;
  - **(f)** a provider request in flight: `deadline`, no parser, no read-only try, no further call.
  - (a) still passes.
- Tests and checks: test first. Full suite green. The log canaries stay green.
- Completion boundary: all T3 boundary cases (a)–(f) pass together.
- Plan ref: §3 T3 step 3b.

### Batch 08: routine typing anchor, server and logic (P2)

Order: T4-1, then T4-2.

**T4-1: server accepts and renders `field_changed`**
- Purpose: a closed reason code for "the anchored field changed".
- Scope: `src/render/routines.ts` (`RUN_REASONS` plus the wording; **Hebrew text written with the
  hebrew-content-writer skill**); `src/channels/app/parse.ts` (automatic through `z.enum`); the
  tests.
- Depends on: none.
- Acceptance:
  - `parse.ts` accepts `field_changed`, and `render/routines.ts` renders it.
  - Mixed-version test: a schema without the code rejects it with a 400; the run settles from
    `unknown` when the report is re-sent to the new schema.
- Tests and checks: full suite green.
- Completion boundary: server code done. The staging deploy is **M3**, and needs the user's
  approval.
- Risks: **server before APK.** The reverse order only delays results, never re-runs.
- Plan ref: §3 T4, "Mixed versions".

**T4-2: field anchor in `RoutineLogic` (pure)**
- Purpose: typing must go into the field the routine tapped.
- Scope: `apps/call-companion/.../RoutineLogic.kt`; `RoutineLogicTest.kt`.
- Depends on: none.
- Acceptance:
  - An anchor is set only when a tap hits an **editable** field.
  - It survives `WAIT`, `WAIT_FOR_TEXT`, `TYPE_TEXT` and `SUBMIT`, and any other tap clears it.
  - At type or submit time, the anchor step's selector is re-resolved:
    - one match, focused → proceed;
    - one match, not focused → `field_changed`;
    - several matches → stop;
    - no match → `field_changed`.
  - With no anchor, today's rule applies.
- Tests and checks: `cd apps/call-companion && ./gradlew testDebugUnitTest`, with these cases:
  - TAP → WAIT → TYPE with focus moved;
  - an anchored field disappearing while another is focused;
  - a non-editable launcher opening a new screen → types;
  - FID-style TYPE with no tap → unchanged;
  - duplicate selectors → stop;
  - a non-field tap clears the anchor.
- Completion boundary: pure logic and tests only. Not wired into the service yet.
- Plan ref: §3 T4, "Proposed", "Screen and window changes".

### Batch 09: app release, typing anchor and mode notes (P2)

Order: T4-3, then T6b-1. Both ship in one APK. **Needs M3 (server first). Blocked by D4** for the
label part of T6b-1 only.

**T4-3: wire the anchor into the runner**
- Purpose: put T4-2 into real runs.
- Scope:
  - `RoutineAccessibilityService.kt`, `RoutineRunner.kt`: add `field_changed` to the app's
    `REASONS`, which otherwise maps it to `error`;
  - `build.gradle.kts`: the next version after the uncommitted 0.13.3 change, which must be
    committed first;
  - `Protocol.kt` vectors, if the reasons appear there.
- Depends on: T4-1 (deployed, M3), T4-2.
- Acceptance:
  - A run stops with `field_changed` in the anchored cases.
  - The app's `REASONS` ⊇ the server's `RUN_REASONS`, by a checklist item or a test vector.
- Tests and checks: `./gradlew testDebugUnitTest`; the server suite. **Device: M4.** Unit tests do
  not establish behaviour in real Android apps.
- Completion boundary: **not done until M4 passes**, the FID routine included.
- Risks: install the APK only after the staging server has the new reason.
- Plan ref: §3 T4; §6, "Physical Android device".

**T6b-1: mode notes match the data flow**
- Purpose: the regular mode is labelled "local" but runs on Groq's hosted models; the smart note
  omits the Groq fallback and the conversation-wide scope of approvals.
- Scope: `apps/call-companion/app/src/main/res/values/strings.xml` (`mode_local_note`,
  `mode_smart_note`, and, if D4 = rename, `mode_local` and `mode_badge_local` plus any guide text).
  **Hebrew copy is written with the hebrew-content-writer and hebrew-i18n skills.**
- Depends on: rides with T4-3's APK. **D4** decides the label.
- Acceptance:
  - No string implies on-device processing.
  - The regular note names Groq, and claims only what Groq's docs support.
  - The smart note says that Gemini falls back to the regular mode's Groq model and that approvals
    cover the conversation.
  - The wire value `mode: 'local'` is unchanged.
- Tests and checks: `./gradlew testDebugUnitTest`; the strings checked on the phone, as part of M4.
- Completion boundary: the strings are reviewed by the user.
- Plan ref: §3 T6, "Disclosure gap", "Two permissions".

### Batch 10: production readiness of the write gate (P1/P2)

Order: T2-5, then T6-1. **Needs M1 and M2.**

**T2-5: record the primary's `evaluated` and make the gate strict**
- Purpose: the primary writes with no recorded evaluation.
- Scope: `src/agent/models.ts` (`evaluated` for qwen: fingerprint, judging, date);
  `test/unit/agent/fingerprint.test.ts` (the primary fails when `canWrite && !evaluated`).
- Depends on: T2-1 to T2-4, and **M2**: a complete passing run, read by the user.
- Acceptance:
  - `evaluated` matches the current fingerprint and judging.
  - The test fails for any writing entry without one.
  - Nothing changes `canWrite` without the user's read.
- Tests and checks: full suite green. **Live:** the M2 run, not repeated here.
- Completion boundary: the values come from the M2 output.
- Plan ref: §3 T2 steps 5–6; PLAN §13 (the owed qwen run).

**T6-1: record the account checks and model status in PLAN**
- Purpose: "verified on <date>" instead of "designed for", and no implied control the account
  lacks.
- Scope: PLAN §13/§14, and §7 if ZDR is unavailable on this tier.
- Depends on: **M1**.
- Acceptance:
  - Each M1 item is recorded, dated, as the user reported it.
  - Any unavailable control is stated as unavailable.
  - Preview model ids are flagged.
- Tests and checks: docs-guard only.
- Completion boundary: nothing inferred beyond the user's report.
- Plan ref: §3 T6.

---

## Optional maintenance (P3), not release blockers

### Batch 11: stuck turns and push visibility (optional)

Order: T8-1, then F17-1.

**T8-1: a stuck `running` turn answers `unknown`**
- Scope: `src/agent/lock.ts` (`heldBy`, checking `expires_at > now`); `src/platform/assistant-do.ts`
  (`duplicateStatus` and the `settled && running` branch of `appDeviceResult`).
- Depends on: **T3-2** (the derived TTL).
- Acceptance: a live turn holding its lock → `pending`; a simulated eviction past the TTL →
  `unknown`.
- Tests and checks: full suite green.
- Plan ref: §3 T8.

**F17-1: repeated push failures show on the status screen**
- Scope: `src/platform/assistant-do.ts` (`pushOutbox`).
- Acceptance: N consecutive failures set `lastErrorCode`, and a success clears the streak.
- Tests and checks: full suite green.
- Plan ref: §2 F17.

### Batch 12: provider failure tests and scrub separators (optional)

**T9-1: Groq agent provider failure paths**
- Scope: `test/unit/agent/provider.test.ts`.
- Acceptance: a 500 and a 503 → `provider_error`, with no exhaustion mark; a non-JSON 200 →
  `invalid_json`.
- Tests and checks: full suite green.
- Plan ref: §3 T9.

**T10-1: phone and email patterns in `scrubForModel`**
- Scope: `src/security/scrub.ts`; `test/unit/security/scrub.test.ts`. Test first.
- Acceptance:
  - Dot- and slash-separated phone numbers, and non-ASCII-local-part emails, are scrubbed.
  - Times and dates are not.
- Tests and checks: full suite green, canaries green.
- Plan ref: §3 T10.

### Batch 13: webhook byte cap (optional, a single-task exception)

This is a single task because nothing else touches WhatsApp ingress. It becomes P2 only if
production `CHANNEL=whatsapp` is live (Plan §7).

**T7-1: `/wa/webhook` through `readCapped`, with the HMAC over bytes**
- Scope: `src/index.ts`, `src/channels/whatsapp/verify.ts`, `src/security/hmac.ts`, the tests.
- Acceptance:
  - A multi-byte body over the cap in bytes is refused.
  - A streamed oversize body is refused without being fully buffered.
  - The Meta vector passes.
  - Invariant 9's order is unchanged.
- Tests and checks: full suite green.
- Plan ref: §3 T7.

### Batch 14: retention of terminal rows (optional, a single-task exception, blocked by D3)

This is a single task because it needs a product decision and its own repeat-reminder check.

**T11-1: purge old terminal reminders and audit rows**
- Scope: `runMaintenance` in `src/platform/assistant-do.ts`; `src/tools/reminder-store.ts`;
  `src/core/repo.ts`.
- Depends on: **D3**; reading the repeat-reminder semantics first.
- Acceptance:
  - Only terminal reminder rows older than N days are deleted.
  - `scheduled` and `sending` rows, and anything a recurrence depends on, are untouched.
  - Old `audit_log` rows are deleted. Rate limits need 24 h.
- Tests and checks: full suite green.
- Plan ref: §3 T11.

### Batch 15: one routine run at a time (optional, a single-task exception)

This is a single task because it is app-side and rides with a future APK.

**T12-1: refuse a second claim while a run is active**
- Scope: `RoutineRunner.kt`, plus a new closed reason on both sides (server first).
- Depends on: T4-3.
- Acceptance: a second due run is not claimed while one runs, and the server records the reason.
- Tests and checks: `./gradlew testDebugUnitTest`; the server suite. **Device:** two runs due within
  a minute.
- Plan ref: §3 T12.

---

## Coverage check

| Plan task | Batch tasks | Required? |
|---|---|---|
| T1 | T1-1, T1-2, T1-3, T1-4 | Yes (P1) |
| T2 | T2-1, T2-2, T2-3, T2-4, T2-5 (+ M2) | Yes (P1) |
| T3 | T3-1, T3-2, T3-3, T3-4 (+ M6) | Yes (P2) |
| T4 | T4-1, T4-2, T4-3 (+ M3, M4) | Yes (P2) |
| T5 | T5-1, T5-2 | Yes (P2) |
| T6 | M1 + T6-1 | Yes (P2; manual) |
| T6b | T6b-1 | Yes (P2) |
| T7 | T7-1 | Optional (P3) |
| T8 | T8-1 | Optional (P3) |
| T9 | T9-1 | Optional (P3) |
| T10 | T10-1 | Optional (P3) |
| T11 | T11-1 | Optional (P3; D3) |
| T12 | T12-1 | Optional (P3) |
| F17 | F17-1 | Optional (P3) |

Totals:
- 15 batches: 10 required, 5 optional, of which 3 are single-task exceptions.
- 27 coding tasks: 20 required, 7 optional.
- 6 manual, live or device items (M1–M6).

