# Routine builder (watch me · tell the bot) — split plan

## Session status
| # | Part | Status | Commit | Next-session prompt |
|---|------|--------|--------|---------------------|
| 1 | Server: `tested` + `routine_untested`; `routine.draft`, routes, prompt (migration 0041) | [~] | | see "Opening prompts" → Session 1 |
| 2 | Watch me: record taps → draft → review; tested flag in the app (app 0.22.0) | [ ] | | Session 2 |
| 3 | Tell the bot, app: push, scan, build draft, review (app 0.23.0) | [ ] | | Session 3 |

## Opening prompts

- **Session 1 (Server):** Read docs/plans/routine-builder.md — only Context, "The rule change", the Sessions table and "Server (part 1)". Do part 1 only. Tests first for src/agent and src/tools. Then typecheck/lint/test, `eval:agent --filter rd- rt- scr-`, `run-screen-evals --draft`, update PLAN/HANDOFF/ARCHITECTURE/runbook, commit, push, deploy:staging, mark part 1 [x] with the hash, and stop with the prompt for part 2.
- **Session 2 (Watch me, app 0.22.0):** Read docs/plans/routine-builder.md — only Context, "The rule change", the status table and "Watch me (part 2)". Part 1 is on staging (the sync schema accepts `tested`). Do part 2 only (app only, no server change). Tests first (`./gradlew testDebugUnitTest`), Hebrew strings through hebrew-content-writer + hebrew-i18n, build the APK to Downloads, update HANDOFF / apps/call-companion/README / PLAN §13 (phone check owed), commit, push, mark part 2 [x] with the hash, and stop with the prompt for part 3.
- **Session 3 (Tell the bot, app 0.23.0):** Read docs/plans/routine-builder.md — only Context, "The rule change", the status table and "Bot app (part 3)". Parts 1–2 are done. Do part 3 only. Tests first, `Protocol.kt` vectors equal to the server's, Hebrew strings through the skills, build the APK to Downloads, update docs, commit, push, mark part 3 [x], and stop.

---


## Context

Today a routine (PLAN §6.27) can be written only by the user in the app's editor
(typing button text by hand, helped by Scan), or by phone code from a confirmed
screen task's actions (phase 3, app 0.21.0). The user wants the bot to build
routines itself, two ways:

- **A. Watch me** — the user does the steps in the app; the phone records them and
  turns them into a routine draft. App only, no model, nothing leaves the phone.
- **B. Tell the bot** — a chat sentence ("build a routine: in the attendance app tap
  כניסה"); the model drafts the steps from the user's words plus the app's **first
  screen** (read, nothing tapped). Nothing runs now.

User decisions (2026-10-15): both ways; B drafts without acting, grounded by a scan
of the first screen; recurring routines are **out** (one run at a time via
`routine.run`, ≤ 7 days — D1 unchanged).

Unchanged: a routine is saved **only by the user on the review screen, after a dry
run of the same `stepHash`** (`RoutinesActivity.kt:747`, `dryRunCovers`
`RoutineLogic.kt:428`). Running a routine stays `routine.run`, Tier 2.

New, because a dry run proves only the first action (`RoutineAccessibilityService.kt:407-430`,
`PLAN.md:2132`), B's later steps were never run anywhere, and a watch-me recording
can miss a tap that sends no click event (web content, some Compose input): **a
recorded or model-drafted routine is saved as untested; it cannot be scheduled
(`routine.run`) or use the stored-PIN unlock until one attended full Run in the app
succeeds for its current `stepHash`.** Any edit resets it. (Screen-task drafts and
hand-written routines are unaffected: tested by default.)

## The rule change (PLAN §6.27 line 2128, new §14 row)

Replace the amended sentence with:

> A routine's steps are written by the user in the editor; by phone code from the
> user's own taps while recording (watch me), or from the actions a confirmed screen
> task performed; or drafted by a model from the user's words and the app's first
> screen, for a confirmed draft request. In a model draft every text is an element of
> the scanned list named by index (phone code takes the selector), or one of the
> words the user confirmed on the card (each found verbatim in their message); kinds
> are the closed set; a step whose text is sensitive or uncertain under the screen
> policy is refused. A model draft's steps cross the server in memory, inside one
> response, never stored or logged. Saved only by the user on the review screen after
> a dry run; a recorded or model-drafted routine is schedulable only after one
> attended full run of the same `stepHash`. Never saved by the server.

Docs quoting the old rule get a dated amendment line (history kept):
`PLAN.md` 2128 + §6.28 (the new screen-text path and its family) + §7 + §14;
`docs/plans/routine-from-screen-task.md` decision 1 and line 157;
`docs/plans/routines.md` 9-10, 34-36; `docs/plans/routines-typing.md:4`;
`docs/plans/screen-agent.md` 211/225; `HANDOFF.md` 114-115, 174-175, §4 rows
(routines, screen agent); `CLAUDE.md` invariant 2 ("The screen": also the first
screen of a confirmed routine draft, same family rule, never stored).

## Sessions (one part per session — split-plan)

| # | Part | Where | Status |
|---|---|---|---|
| 1 | Server: `tested` sync field + `routine_untested`; `routine.draft`, routes, prompt | server, migration 0041 | [ ] |
| 2 | Watch me: record the user's taps → draft → review; tested flag in the app | app 0.22.0 | [ ] |
| 3 | Tell the bot, app: push, scan, build draft, review | app 0.23.0 | [ ] |

Server first: the sync schema is `.strict()` (`parse.ts:288-303`), so the app may send
`tested` only after part 1 is on staging. Part 1's commit copies this plan to
`docs/plans/routine-builder.md` with an opening prompt per part. The sections below
keep their letters: **Server** = part 1, **Watch me** = part 2, **Bot app** = part 3.

**Hebrew strings** (all parts — notification, review banners, spoil texts, confirm
card, chat replies): written with `hebrew-content-writer` + `hebrew-i18n`, never from
memory. Wording in this plan is a placeholder.

---

### Watch me (part 2 — app only, after part 1 is on staging)

**Flow.** Routines screen → "record a routine" → `chooseApp()` (`RoutinesActivity.kt:907`)
→ recording starts for that one package and launches it → ongoing notification
(stop · cancel) → the user acts → Stop → draft → existing review (`startReview`
:578) with the dry-run gate → Save.

**Recording is a worker job** (`RoutineAccessibilityService.kt:68-69`): one at a
time with runs, scans and screen tasks.
- While recording: the recorded package is kept in `applyPackages` (:104-115), and
  event types widen via `setServiceInfo` (`TYPE_VIEW_CLICKED | TYPE_VIEW_TEXT_CHANGED
  | TYPE_VIEW_SCROLLED`); both restored on stop / cancel / timeout / `onDestroy`.
  `routine_service.xml` unchanged.
- Events are recorded only while `runningPackage == null` (no service action
  running) and only from the recorded package. Leaving the app (another package's
  window, except the OEM "allow open" dialogs) stops with `user_left_app`.
- A routine push or screen task arriving mid-recording wins: it sets the recording's
  cancel flag (an `AtomicBoolean` the recording job polls, like the run deadline), the
  recording ends as spoiled `user_interrupted` (buffer dropped), then the queued job
  runs. The relock count (`:190`) treats the recording as a job.
- Timeout 5 min → cancelled. On spoil / cancel / timeout the buffer (incl. typed
  text) is dropped. Nothing is written to storage before Save.

**New pure class `UserRecording.kt`** (JVM-testable):
- click → `TAP_TEXT`/`TAP_ID` via the **same selector** as the screen recorder:
  extract `RoutineRecording.selector()` (:130) into `RoutineLogic` (tests move too).
  No unique selector → `user_no_selector`.
- text changed on an editable node → buffered per field (last value wins); emitted
  as `TYPE_TEXT` on the next click or Stop, with the anchor tap rule of
  `RoutineRecording.type` (:100-108). Password node → `user_password`, text never
  read. Longer than `MAX_TEXT` → `user_too_long`.
- scroll → `user_scrolled`. More than `MAX_STEPS` → `user_too_long`.
- Keyboard Enter is not observable: when a `TYPE_TEXT` is the last step, the review
  banner suggests adding `SUBMIT` (the editor already can).
- Own spoil set `UserRecording.SPOIL_REASONS` + `spoiledText` (tested; `user_`
  prefix so they never clash with `RoutineRecording` / `SCREEN_END_REASONS`).

**One draft slot** (`RoutineDrafts.kt:34-38` replaces silently today): the slot
holds `reviewingId` — set by `RoutinesActivity.onResume` when it shows that draft's
review, cleared in `onStop` and whenever review mode is left (back to the list,
Save, Discard), and dead with the draft's TTL or the process. `offer`
refuses while `reviewingId` equals the current draft, and the newcomer gets a fixed
"draft not kept — finish the open one" notice; otherwise it replaces the old draft
with a notice. Applies to all sources. Draft carries `source`
(`screen_task | recorded | bot`) shown in the review banner.

**Tested flag** (also used by part 3): `RoutineStore` JSON gains `source` and
`testedHash` (missing = manual, tested). A `recorded`/`bot` routine is tested when an
attended Run (`run(dryRun=false)`, :273) ends `verified`/`tapped_unverified` for its
current `stepHash`; any edit resets it. The list row shows "untested — run once".
A second guard beside the server's `routine_untested`: `RoutineRunner` refuses to
unlock or run a claimed run of an untested routine (reported as the existing
`changed`-style refusal; no new reason code unless `RUN_REASONS` gains one on both
sides). Sync sends `tested` (part 1's schema).

**Tests.** `UserRecordingTest` (event sequences → steps/spoils, password never read,
coalescing, foreign package ignored, events during a service action ignored,
interrupt drops buffer), `RoutineLogicTest` (moved selector), `RoutineDraftsTest`
(slot and `reviewingId` rules), tested flag (set, reset on edit, unlock refused,
synced), `Protocol` vector for sync with `tested`, existing `RoutineRecordingTest`
green.

**Docs.** PLAN §6.27 (watch-me half) + §14, `routine-builder.md`, app README,
HANDOFF §1/§6. App 0.22.0, APK to Downloads.

---

### Server (part 1)

**`tested` gate first:** `routineSyncSchema` (`parse.ts:288-303`, `.strict()`) gains
optional `tested` (absent = true); the routine names table gains `tested` (migration
0041, default 1); `routine.run` resolve refuses `tested = 0` with `routine_untested`
("run it once in the app first"). `KNOWN_CAPS` (`parse.ts:180`) gains `'routine_draft'`.

**Tool `routine.draft`** (`src/tools/routine-draft.ts`, registry beside :322-354):
- Input (strict Zod): `app` (≤ 40, resolved against `screen_allow` like
  `screen.task`), `goal` (≤ 200), `inputs` (≤ 3 × ≤ 60, text to type) and `words`
  (≤ 5 × ≤ 60, button/label texts the user named) — both checked verbatim against the
  message with `inputsSaid` (`screen.ts:69`) **at resolve**, and shown on the card.
  The message itself is never kept (voice transcript, invariant 13).
- Tier 2, `refusesTainted`, `dataSource: 'private'`, `private: true`, app channel
  only. Rate 10/day.
- Offered only when named **and** the device advertised `routine_draft`: a name check
  in `agent/tools.ts` beside :215-222 (`options.routineBuild && options.routineDraftCap`),
  both flags passed from `pipeline.ts:1189-1225`. `routineBuild` comes from its own
  `namesRoutineBuild` (the routine word `/שגר|רוטינ|routine/` plus a build verb —
  works with zero synced routines, unlike `namesRoutine` `pipeline.ts:2232`); own
  group, the `selectTools` special case (`tool-groups.ts:217-256`) and `RIDE_ALONG`
  (:260-269). Never in the full catalog, so the eval fingerprint does not move
  (`test/evals/fingerprint.ts:25,52`).
- `startBlocked`: a screen task open, a draft open, a routine due within 15 min
  (push + 10 min claim window). `screen.task`'s `startBlocked` (`screen.ts:150-158`)
  gains "a draft open".
- Confirm card (code): opens the app to read its first screen, taps nothing, saves
  nothing until the user saves on the phone.

**Table `routine_drafts`** (migration `0041_routine_drafts.sql`, registered in
`src/platform/migrations.ts`, same migration as the `tested` column): id, `sealed`
(goal + inputs + words from the confirmed input, AES-GCM via `src/security/crypto.ts`,
cleared once the model has answered or at any earlier end), `mode` (local/smart, from
the confirmed input), status, timestamps. Every move is one conditional `UPDATE`:
- `confirmed → pushed → claimed → drafted` (in flight);
- `drafted → offered | build_failed | slot_busy` (by the result route — final);
- `claimed → failed` (model/validation failure — final);
- ends by sweep: `pushed → expired`, `claimed → unknown`, `drafted → unknown`
  (each after 10 min); `→ preempted` when a routine is due.
Own `DraftStore` with its own `preempt` (not the screen store's `preemptAll`).

**Routes** (signed; `ingress.ts` caps; `parse.ts` schemas; app `Protocol.kt` vectors):
- `POST /app/routine/draft/claim` — `pushed → claimed`, once; 409 otherwise.
- `POST /app/routine/draft/screen` — `claimed → drafted|failed`; body = draft id +
  snapshot in the **screen step's existing schema** (≤ 80 elements, binding `b`,
  ≤ 2,500 chars). Response carries the steps. A lost reply is not retried: a repeat
  post gets 409, the phone shows "draft lost, ask again" (tokens already spent —
  accepted, said in PLAN).
- `POST /app/routine/draft/result` — closed codes. From `claimed` (before the screen
  post): `locked`, `app_not_front`, `launch_confirm` → `failed`. From `drafted`:
  `offered`, `build_failed`, `slot_busy` → that status. The chat line is
  code-rendered.

**Sweeps** (in `alarm()` beside `serviceRoutines`, `assistant-do.ts:546-579`): the
three 10-minute sweeps above; user told once each. A due routine preempts an open
draft through `DraftStore.preempt`, called beside `this.screen.preemptAll` (:562).

**The model call** (`src/agent/routine-draft.ts`):
- `DRAFT_MODELS` = qwen → gpt-oss-120b (Groq) for local; `DRAFT_SMART_MODELS` =
  Flash-Lite only (never Flash — its 20/day belong to the screen agent,
  `models.ts:194`). Never crossing families.
- Tokens written to `screen_model_day` like a screen step (`screen-store.ts:453-459`,
  `screen-step.ts:589`), so drafts share `SCREEN_GROQ_DAY_TOKENS`.
- Screen text through `scrubForModel`; never stored, logged or put in history.
- `fetch` through a closure with the turn signal; placed in
  `test/security/turn-signal-fetch.test.ts`.
- Prompt `ROUTINE_DRAFT_PROMPT_VERSION = 'rd1'`. Output: strict Zod discriminated
  union per kind, ≤ 10 steps:
  - `TAP_TEXT | WAIT_FOR_TEXT | EXPECT_TEXT | EXPECT_DISABLED`: `element` (index) **or**
    `said` (text).
  - `TAP_ID`: `element` only.
  - `TYPE_TEXT`: `input` (index into `inputs`) + optional `element` (the field); the
    phone applies the anchor rule.
  - `SUBMIT`: nothing. `WAIT`: `seconds` ≤ `MAX_PAUSE_SECONDS`.
  - `seconds` within routine limits; `note` ≤ 120 chars, display-only, defanged.
- Code checks after Zod: every `said` equals one of the confirmed `words` (never the
  model's `goal`); index in range; the screen policy (`src/agent/screen-policy.ts`):
  `TAP_TEXT`/`TAP_ID` → `riskClass('tap', …)` with `askEveryTap: false`,
  `typedNonSearch: false`, must be `safe` (sensitive or generic/unlabelled refused);
  check steps, `TYPE_TEXT` and `SUBMIT` → only the `SENSITIVE_WORDS` test (:30) on
  their text, so "type, then Enter" and `EXPECT_TEXT` are not refused as generic.
  Failure → next model in the family once, then `failed` with a code reason.
- Response: `{steps:[{kind, b?|text?|input?, seconds}], note?}` — the server maps
  index → binding like screen actions.

**Tests first**: schema rejects invented text, unknown index, wrong field per kind,
`said` not in `words`, `words`/`inputs` not in the message, sensitive/uncertain
labels, > 10 steps; claim once; every status move and sweep; tainted refused; not
offered without the cap or the name; `DRAFT_MODELS`/`DRAFT_SMART_MODELS` never cross
and never hold Flash; tokens land in `screen_model_day`; screen text and step texts
absent from logs (canary) and DB; message never in `pending_actions`;
`routine_untested`; sync without `tested` defaults true; `KNOWN_CAPS` keeps
`routine_draft`. **Evals**: `rd-` cases in `cases.routines.yaml` (not fingerprinted;
`routine.draft` for "build a routine…", `screen.task` for "do it now");
`run-screen-evals.ts --draft` mode for `rd1` (a new flag in its closed parser,
:368-373; `--model` accepts the `DRAFT_*` ids in that mode; own gates: 100% schema
pass, 0 invented texts, including vectors with a sensitive word inside a `said`
text — no screen element there, so only the word list catches it). **Docs**: PLAN §6.27/§6.28/§7/§14, ARCHITECTURE (tool, table, routes),
HANDOFF §4/§6, `ops/runbook.md` routes. `pnpm deploy:staging`.

---

#### Part 1 build notes (2026-10-15) — these win over the section above

- **Wire, claim** (`/app/routine/draft/claim`, body `{draftId}`): `200 {status:'ok',
  package, label, inputs}`; anything but a pushed draft within its 10 minutes is
  `409 {error: 'not_found'|'already'|'late'|'ended'}`. The inputs are given here (the
  phone needs them to build `TYPE_TEXT` steps); the goal and words never leave the server.
- **Wire, screen** (`/app/routine/draft/screen`, body `{draftId, screen}` in
  `screenSchema`): `200 {status:'ok', steps, note?}` or `200 {status:'failed', reason}`;
  a repeat post, or a draft preempted or swept during the call, is `409 {error:'not_open'}`.
  A step is `{kind, seconds, b?, i?, text?, input?}`: `b` is the phone's binding when
  the element has one, else `i` is its index in the posted list (a plain text, for a
  check step); `text` is a confirmed word, as confirmed; `input` is **1-based** into the
  claim's `inputs` (as the screen agent's `type`). `seconds` is always set (default 15;
  `WAIT` 1–5, others 1–60). `TAP_ID` always carries `b` (the element had a view id).
- **Wire, result** (`/app/routine/draft/result`, body `{draftId, code}`): `200 {status:'ok'}`
  or `409 {error:'not_open'}`. `locked`/`app_not_front`/`launch_confirm` only before the
  screen post; `offered`/`build_failed`/`slot_busy` only after a draft.
- **Push:** FCM data `{kind: 'routine_draft', draft_id}`.
- **Failure codes** a chat line names: `locked`, `app_not_front`, `launch_confirm`,
  `model_error`, `unsafe_step` (code refused the draft), `model_unclear`,
  `model_not_found`, `model_sensitive` (the model's own `{"fail": …}`), `quota`, `busy`,
  `sealed_missing`, `not_allowed`.
- **Group:** `routine.draft` sits in the `routine` group beside `routine.run` (rides
  along, never inherited) instead of a group of its own: no new fallback examples needed.
- **The model call** goes through `AgentProvider.complete` (no new `fetch` call site, so
  `turn-signal-fetch.test.ts` is unchanged); it takes no agent lock (one call per
  draft, the budget's reservation guards the minute bucket).
- **`tested`:** the sync's optional boolean; the server stores it and `routine.run`
  refuses `false` at resolve and at execute. The stored-PIN unlock gate is the app's.

### Bot app (part 3)

- Push `routine_draft` dispatched in `CompanionMessagingService.kt:39-46` → a worker
  job: claim → open the app fresh (as `scanNow`, :152) → snapshot with bindings via
  the screen agent's snapshot code, node map in memory → post → result.
- Build the draft **in phone code**: `element` → bound node → the shared selector
  (part 2); `said` → that text; `TYPE_TEXT` → the input value (from the confirmed
  inputs echoed in the response) + anchor rule; `RoutineLogic.problem()`. Failures →
  `build_failed`. Then `RoutineDrafts.offer` (`slot_busy` if refused) → notification
  → review.
- Review: banner "drafted by the bot", every step after the first action marked
  "not checked by the dry run", the capped `note`. Save gate unchanged.
- Saved with `source = bot`, so the tested flag from part 2 applies.
- Device cap `routine_draft` advertised. Caps go only with the push-token route
  (`assistant-do.ts:2126-2131`): the app re-sends it once after an upgrade (stored
  app version ≠ current), so 0.23.0 is offered the tool without a token change. It
  sends the **full** caps list (`setCaps` replaces it, :2131).
- Tests: Protocol vectors (claim, screen, result, caps list), draft builder (binding →
  selector, unknown binding, `said`, `TYPE_TEXT` anchor), caps re-send on upgrade,
  strings. App README. App 0.23.0, APK to Downloads.

## Verification

- Each part: `pnpm typecheck && pnpm lint && pnpm test` (server), `./gradlew
  testDebugUnitTest` (app).
- Part 1: `pnpm eval:agent --filter rd-` (+ `rt-`, `scr-`) with a human read;
  `run-screen-evals.ts --draft`; fingerprint test unchanged; `pnpm deploy:staging`,
  version id in session log; `wrangler dev` CPU of a full snapshot post.
- Phone checks (PLAN §13, after M4): A — record "open attendance → tap כניסה",
  review, dry run, save, scheduling refused as untested, one attended Run, schedule.
  B — "build me a routine: in attendance tap כניסה",
  confirm, app opens and nothing is tapped, review, dry run, save, scheduling refused
  as untested, one attended Run, then schedule.

## Caught in review (round 1)

- [data] steps crossed the server against the rule → rule amended: in memory, one
  response, canary test.
- [data] lost reply / stuck claim / phone errors → separate claim, screen, result
  routes; sweeps.
- [data] token share not wired → written to `screen_model_day`.
- [concurrency] service's own taps recorded as the user's → recording is a worker
  job; events ignored while the service acts; interrupt spoils.
- [concurrency] `applyPackages` reset drops the recorded app → kept in the filter.
- [concurrency] single draft slot overwritten → refuse while reviewing, notice.
- [concurrency] due routine vs. draft → `preemptAll`, 15-min guard, `screen.task`
  blocked by an open draft.
- [consistency] dry run proves only the first action → untested gate on scheduling and
  unlock, sensitive words refused.
- [consistency] step schema self-contradiction → per-kind union.
- [consistency] `said` checked against `goal` → against the user's message.
- [consistency] offer flag needed routines synced → own `namesRoutineBuild`.
- [consistency] wrong push entry, old APK → `CompanionMessagingService`, `needsCap`.
- [blast-radius] fingerprint claim, eval runner, turn-signal test, docs, spoil-code
  clashes, Flash quota, Hebrew strings → fixed above.

## Caught in review (round 2)

- [data] sealing the message would store a voice transcript → `words` slot checked
  at resolve, message never kept.
- [data] `drafted` ambiguous / unswept → explicit state machine, `drafted` swept.
- [concurrency] review-open flag lifecycle → `reviewingId` set in `onResume`, cleared
  in `onStop`, dies with TTL. Recording cancel flag; own `DraftStore.preempt`.
- [consistency] `needsCap` is file-only → `KNOWN_CAPS` + name check in
  `agent/tools.ts`.
- [consistency] watch-me may miss taps → recorded routines are untested too; parts
  reordered so the server `tested` field ships first.
- [consistency] uncertain labels → `riskClass` must be `safe`.
- [blast-radius] caps re-send after upgrade, strict sync schema, draft model-list
  tests, `--draft` model ids and gates.

## Round 3: APPROVE. Its five NITs are folded in (riskClass call spec,
`reviewingId` cleared on leaving review mode, untested guard in `RoutineRunner`, full
caps list, `said` sensitive-word eval vectors).

Rejected: none. Rounds: 3.
