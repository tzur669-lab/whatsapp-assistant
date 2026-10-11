# Routines — multi-step phone actions, now or later, even when the phone is locked

## Context

The user wants one instruction to run several steps, now or in the future.
Example: "in 15 minutes open the attendance app (clockok2go2020) and tap כניסה".
Answers: punch is tap-only (no GPS), phone lock is biometric + PIN, and at
fire time the user wants **full automatic execution, no tap**.

Today:
- Phone actions are closed cards run by `DeviceActions.kt` via intents; cards
  run only after a one-shot claim (`assistant-do.ts:1196-1234`) and only from
  `ChatActivity`. No AccessibilityService, no UI automation. On a locked phone
  only FCM's ~10 s window and `ConfirmCallActivity` (`showWhenLocked`) run.
- Future jobs: `reminders` table + `AssistantDO.alarm()`; the only future
  "actions" are scheduled reads (closed `ScheduledTopic`). None writes.
- Invariant 10: one command → at most one action.

### Platform fact
With a **secure** lock (fingerprint/face + PIN) no app can unlock the phone or
tap inside another app behind the lock screen. Android forbids it. So:
1. **Extend Unlock / Smart Lock "trusted place" = the workplace.** At work the
   phone, once unlocked that day, wakes without auth → **fully automatic**.
2. **Fallback, still automatic after one touch:** if the keyguard is secure at
   fire time, a full-screen prompt appears; one fingerprint touch and the
   routine runs alone.
Server-side punching (vendor web portal) was dropped: no public API found, and
it would need employer credentials in the Worker.

## Design — a "routine" is a named, closed step list the user builds on the phone

The server schedules **one action** (`routine.run`) and authorizes **one run**.
The steps live on the phone, written by the user in the app; never by the
model, never sent by the server. Screen content never leaves the phone.

### Phone (apps/call-companion) — app 0.13.0
1. **`RoutineAccessibilityService`**: restricted at runtime
   (`setServiceInfo.packageNames`) to the packages of saved routines; runs one
   routine at a time (a queue; a second waits until the first ends).
2. **Routine storage** (DB v5): stable `routineId` (UUID), `name`, target
   package (installed-app picker), steps of a closed kind — `OPEN_APP`,
   `WAIT_FOR_TEXT(text, ≤20 s)`, `TAP_TEXT(text)`, `TAP_ID(viewId)`,
   `WAIT(≤5 s)`; max 10 steps; no typing. `stepHash` = SHA-256 of the
   canonical step list.
3. **Routines screen**: create / edit / delete / "test now" (unlocked).
4. **Sync:** signed `POST /app/routines` — full list of
   `{routineId, name (≤40), stepHash}` after every change; replaces the
   server copy in one transaction.
5. **Fire path:** FCM data push `kind: routine` {runId} with FCM `ttl` 10 min
   → `RoutineRunActivity` (`showWhenLocked`, `turnScreenOn`) →
   **signed one-shot claim** `POST /app/routine/claim {runId, routineId, stepHash}`
   → only `ok` continues → `requestDismissKeyguard` (secure → fingerprint
   fallback) → launch package (reuse `DeviceActions` launch) → service runs
   steps.
6. **Result:** signed `POST /app/routine/result {runId, outcome, failedStep}`
   (`done | failed | unknown_routine`, no screen text), retried until 2xx.
   Failure → high-priority notification with an "open the app" action.
7. **Guide** (`GuideActivity`): accessibility service on, "Allow restricted
   settings" (sideloaded APK), full-screen-intent grant (Android 14+,
   `AndroidManifest.xml:14` already declares it), battery-optimization
   exemption, Extend Unlock at the workplace.

### Server (bot)
1. **Tool `routine.run`** (`src/tools/routine.ts` + registry): slots
   `routine` (words, matched in code against `routine_names`; no match or
   several → CLARIFY; invariant 5) and optional `when` (TimeSpec →
   `src/time/resolve.ts`; missing `when` = now). **Tier 2**, confirm in chat:
   "יום א׳ 11.10 · 09:15 — אפעיל את ⁨clock in⁩" (weekday + date + time, name in
   FSI/PDI via `src/render/bidi.ts`). `dataSource: 'reminders'` — names are
   the user's own labels and appear in `reminders.list`, like reminder text.
   **A tainted turn cannot schedule a routine at all** (policy reason → refuse).
   Agent-only, not in `PARSER_TOOL_NAMES`. No recurrence in v1.
2. **Catalog headroom (PLAN.md:2803, ~100 tokens left):** `routine.run` is in
   its own tool group that is **never in the full catalog**; it is offered only
   when code selects it — the message contains a synced routine name or
   "רוטינה/שגרה/routine". Concretely: `selectTools` (`agent/tool-groups.ts:176-179`)
   gets the synced names as a new argument (read from `routine_names` by the
   caller, so `tool-groups.ts` stays pure), and the "no group matched → all of
   `offered`" branch removes `routine.run`. ARCHITECTURE records it. Fingerprint
   (`test/evals/fingerprint.ts`) changes → rerun owed prefixes.
3. **Storage — migration `0028_routines.sql`** (+ `src/platform/migrations.ts`):
   - `routine_names(routine_id PK, name, step_hash, updated_at)`.
   - `reminders.kind TEXT NOT NULL DEFAULT 'plain'` (`plain | read | routine`,
     backfill `read` where `action` is set) + nullable `routine_id`,
     `step_hash`. The row's `text` holds a code label, never model text.
   - `routine_runs(run_id PK, reminder_id UNIQUE, status, pushed_at,
     not_after, claimed_at, settled_at)`; status
     `pushed → claimed → done|failed|unknown` or `pushed → cancelled`, each
     step an `UPDATE … WHERE status = <prev>` (idempotent). Created with
     `INSERT OR IGNORE` and read back, so a lease retry of the same reminder
     (`reminder-store.ts:216`, `MAX_ATTEMPTS` 5) reuses the one `run_id`.
   - Every `action === null` / `action IS NULL` site switches to `kind`:
     `assistant-do.ts:381-390` (deliver / `takeFailed`),
     `reminder-store.ts:528` (`plainOnly`, digest `src/core/digest.ts:99,101,275`),
     `materializeNext` (`reminder-store.ts:250-268`, routines never recur),
     `reminders.repeat` refuses routine rows.
4. **Firing** (`AssistantDO.alarm()`): a `routine` row → `deliverRoutine`:
   - late > `ROUTINE_MAX_LATE_MS` (10 min, new named constant) → dropped with
     a reply "לא הופעל — עבר הזמן" (not via `takeFailed`). Rows held by
     `canDeliver`/Shabbat hold (`assistant-do.ts:358-373`) are dropped the same
     way — on purpose.
   - else insert `routine_runs` (`not_after = due + 10 min`), outbox note,
     FCM `kind: routine`. A re-push reuses the same `run_id`.
   - At most one routine run per minute (a second due in the same minute waits).
5. **Claim route** (same ingress order as other app routes, invariant 9), one
   transaction: run `pushed`, row not cancelled, `now ≤ not_after`, synced
   `routine_id` exists and `step_hash` equals the one stored at confirm
   (invariant 7: the confirmed steps, not edited ones) → `claimed`. Anything
   else → refuse with a code the phone shows. Double push / FCM redelivery →
   the second claim fails → never punches twice.
6. **Result route**: settles once; reply via outbox:
   "✔ ⁨clock in⁩ הופעל · יום א׳ 11.10 · 09:15" or the failure text.
7. **Cancel:** `reminders.cancel` / `reminders.list` also look in
   `routine_runs` (today they see only `status = 'scheduled'`,
   `reminder-store.ts:145, 419-420`): a `pushed` run → `cancelled` (the claim
   then refuses it); a `claimed` run → "כבר התחיל".
   **Stale-claim sweep** in `alarm()` next to `settleExpiredTurns()`
   (`assistant-do.ts:345`): a run `claimed` for > 5 min with no result →
   `unknown`, reply "לא ידוע אם הופעל — כדאי לבדוק באפליקציה".
8. **Fire-time auto-run gate (D1):** only `kind = 'routine'` rows created by a
   confirmed `routine.run` pending are ever pushed; nothing else auto-runs.

### Decisions that change invariants — the user approves; PLAN §14 rows
- **D1:** a confirmed future write runs at fire time with no tap. Only
  `routine.run`, one run, one claim, 10-minute window.
- **D2:** UI automation through AccessibilityService = a closed user-built step
  list, not "code execution" (no Tier 4).
- **D3:** "several steps in one instruction" = a routine on the phone. Chaining
  different server tools in one message stays forbidden (invariant 10).
- **D4:** a tool outside the full catalog, selected by user-synced names.

## Files
- Server: `src/tools/routine.ts` (new), `src/tools/registry.ts`,
  `src/tools/reminders.ts` (list/cancel/repeat), `src/tools/reminder-store.ts`,
  `src/core/digest.ts`, `src/agent/tool-groups.ts`, `src/platform/assistant-do.ts`,
  `src/channels/app/parse.ts` (+ sync/claim/result routes), `src/device/fcm.ts`,
  `src/render/routine.ts` (new), `migrations/0028_routines.sql`,
  `src/platform/migrations.ts`, `test/evals/fingerprint.ts`, eval cases `rt-`.
- App: `RoutineAccessibilityService.kt`, `Routines.kt`, `RoutineRunActivity.kt`,
  `RoutinesActivity.kt` (new), `CompanionMessagingService.kt`, `Protocol.kt`
  (+ vectors for sync/claim/result), `AndroidManifest.xml`,
  `res/xml/routine_service.xml`, `GuideActivity.kt`.
- Docs: PLAN §6.27 (new; note in §6.20 on routine claim vs card claim), §14
  rows D1–D4, HANDOFF, ARCHITECTURE, add-tool skill checklist.

## Verification
- Server, test-first: Tier 2 confirm; tainted → refused; "בעוד רבע שעה" via
  resolve; DST fold; unknown/ambiguous name → CLARIFY; late > 10 min → drop
  message; not in digest, not in `takeFailed`, no successor; double claim →
  second refused; claim after `not_after` → refused; cancel after push vs
  after claim; edited steps (hash mismatch) → refused; duplicate result → one
  reply; lease retry → same `run_id`; stale claim → `unknown` reply;
  `routine.run` absent from the full catalog, present when a name is said; ingress tests on the three routes; log canary.
  `pnpm typecheck && pnpm lint && pnpm test`; `pnpm eval:agent --filter rt-`
  plus the prefixes the fingerprint change makes owed.
- App: `./gradlew testDebugUnitTest` (step validation, hash, protocol
  vectors). On the phone: "test now" unlocked; scheduled run, screen off at a
  trusted place (full auto); scheduled run with secure lock (one touch);
  phone offline past 10 min → nothing runs; text missing → failure notice.
- Deploy: stacked after 0.12.0 — migration 0028 goes to staging only after
  0027; server before the 0.13.0 APK.

## Rejected objections
- None (all round-1 items applied).

## Round 3 — architecture review fixes (applied 2026-10-11)
- **B1 order:** unlock first, then claim, then run. The phone has a hard run
  deadline (auth wait ≤ 2 min + steps ≤ 4 min); the stale-claim sweep fires
  only after deadline + report slack (10 min). A late result moves
  `unknown → done/failed` and sends one follow-up.
- **B2 runtime guard:** before every action the service checks the active
  window's package == routine target and `!isKeyguardLocked`; taps only by
  `ACTION_CLICK` on a node re-read from that window. No coordinate gestures,
  no global actions, no scroll, no long-press, no typing.
- **B3 verification:** `EXPECT_TEXT` step; outcomes `done_verified`,
  `tapped_unverified`, `failed_before_action`, `unknown`. Matching is exact
  (normalized), exactly one visible+enabled+clickable match (or nearest
  clickable ancestor), after the screen is stable ~500 ms.
- **B4:** `materializeNext` copies `kind`; test for a recurring read.
- Risks taken: confirm text includes target app + last tap label (synced
  summary); schedule horizon ≤ 12 h in v1; a 2-min-before notice with "בטל";
  routine edit/delete cancels pending rows at sync time; whole-phrase name
  matching + overlap evals; visible notification on the routine push;
  `canUseFullScreenIntent()` check in the guide; local "claimed" record, no
  retry after process death; backfill only `SCHEDULED_TOPICS`.
- **Dry run** (the user is clocked in and must not tap): "בדיקה יבשה" walks
  the steps up to the first tap, finds the target, highlights nothing, taps
  nothing, and reports what it found.

## Stages
0+1 (now, app only): routine model, storage, editor, accessibility service
with the runtime guard, dry run, run-now (unlocked). No server changes.
2: server (sync, confirm, schedule, claim, cancel). 3: locked phone and
fingerprint fallback. 4: sweep, late results, diagnostics.
