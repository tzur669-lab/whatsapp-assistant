# Routines — save a screen task as a routine (2026-10-15)

Screen agent phase 3 (PLAN §6.28, `docs/plans/screen-agent.md` "Phases"), and the
routines item "the bot builds a routine on request and explains it" (HANDOFF §6,
the user's wish of 2026-10-11). Reviewed: plan-review, rounds listed at the end.

## The user's decisions (2026-10-15)

1. **Recording, not drafting.** A routine is built from a screen task that already
   ran. Phone code turns the actions that actually ran into routine steps. The model
   never writes a step, a selector or a text: it only picked elements by index during
   the task, as today. Drafting a routine from words by a model is **out**.
2. **The explanation is code.** The phone writes it from the steps with fixed
   sentences. No model, nothing leaves the phone.
3. **The draft lives in memory only, 30 minutes** (the user's choice, after review
   round 1), until the user taps Save, so "screen text is never stored" (CLAUDE.md
   inv. 2, HANDOFF §4) holds unchanged. Accepted cost: a draft is lost if Android
   kills the app before Save. Rejected: private storage for 24 h (it would store
   labels from another app's screen before the user agreed).

## Amendment

PLAN §6.27 "never written by a model" becomes: *a routine's steps are written by the
user in the editor, or by phone code from the actions a confirmed screen task
performed (the model chose which element; code chose the selector and the text), and
are saved only by the user on the review screen. Never from a model's text, never by
the server.* A dated PLAN §14 line records it. With decision 3, no
CLAUDE.md invariant changes: screen text reaches storage only when the user saves a
routine (the same as typing it into the editor), the server never sees steps (names
and a hash, unchanged), invariant 10's task loop is unchanged, and a saved routine
runs through the existing Tier 2 `routine.run` confirm.

## What is recorded

The recorder is a pure `RoutineRecording` class (JVM-testable), one per `ScreenRun`,
fed by `ScreenRun.dispatch` (`ScreenRun.kt:304`) with the action, its `Target`
(`nodes`, `index`; `RoutineAccessibilityService.kt:637`) and the outcome. It keeps a
**field anchor** the same way the runner does (`RoutineLogic.anchorAfter`,
`RoutineLogic.kt:292`): the binding (`ScreenLogic.binding`, which leaves out an
editable node's text, `ScreenLogic.kt:402`) of the last recorded tap on an editable
field; any other tap clears it; `wait`, `type`, `submit` keep it. "The same field"
always means the same binding.

**The selector for a node** (tap targets and inserted field taps), candidates in this
order, the first for which `RoutineLogic.pickTarget(nodes, step)` returns exactly
`One(index)` and `stepProblem(step) == null`:
1. `TAP_TEXT` with the node's own text (non-editable) or its hint (editable);
2. `TAP_TEXT` with its description;
3. `TAP_TEXT` with the own text of **one** descendant whose `target == index`
   (`pickTarget` maps a descendant's hit to its nearest clickable ancestor,
   `RoutineLogic.kt:256`). Never the joined " · " child label
   (`ScreenLogic.kt:280-285`) and never a lender label (a lender has `target < 0`,
   `ScreenLogic.kt:259`, so `pickTarget` cannot reach it): a node named only that
   way is refused (`no_selector`);
4. `TAP_ID` with its view id.

Every recorded tap has `seconds = DEFAULT_SECONDS` (part of `stepHash`,
`RoutineLogic.kt:150-152`).

| Screen action (DISPATCHED) | Routine steps | Refused (no draft) when |
|---|---|---|
| `tap` | `TAP_TEXT`/`TAP_ID` by the selector rule; updates the anchor | no selector (`no_selector`) |
| `type` (input k) | the text is `task.inputs[k-1]` trimmed. If the anchor is this field's binding → `TYPE_TEXT`. Else if there is **no anchor** and `pickField(nodes, needFocus = false)` on that snapshot is `One(index)` → `TYPE_TEXT` (today's rule, FID). Else (an anchor on another field, or no unique field) → the field's selector tap, then `TYPE_TEXT`: at run time an anchor makes `anchoredField` use only that field (`RoutineLogic.kt:302-316`) | the read-back after typing did not match (below); no selector for the inserted tap; password field |
| `submit` | `SUBMIT` | the anchor is another binding, or there is no anchor and `pickField(nodes, needFocus = true)` is not `One(index)` (`not_field`) |
| `wait` s | `WAIT` min(s, `MAX_PAUSE_SECONDS`) | — |
| `scroll`, `back` | — | always (`scrolled`, `went_back`): routines have neither (PLAN §6.27) |

**Typing read-back.** The screen agent counts a `type` as dispatched on Android
accepting `SET_TEXT` and ignores the read-back (`RoutineAccessibilityService.kt:716`
uses `.first` of `type`, `:546`), while a routine fails on the same mismatch
(`:437`). So `ScreenOps.fire` also returns the read-back result for `type` (a second
value, not a change to what the task does), and a mismatch spoils the recording
(`typed_differs`): such a routine would fail on every run.

**The draft is spoiled** — kept as a reason code only, no steps — by: any refusal in
the table; any action in the task whose outcome is not `DISPATCHED` (`NOT_ACCEPTED`
does not end the task, `ScreenRun.kt:333-353`, so a skipped action would make the
draft differ from what ran); more than `MAX_STEPS` (10) steps (`too_long`); no action
step at all (only waits, or none: `no_action`, it would fail `problem`'s `no_tap`,
`RoutineLogic.kt:110-111`).

**Only a clean finish offers a draft.** `ScreenRun.handle` on `Answer.End(outcome)`
(`ScreenRun.kt:114`) calls `finish(outcome)`: only `completed_unverified` (the model's
`done`, `src/agent/screen-step.ts:639`) with an unspoiled recording yields a draft.
`inconclusive`, `asked`, failures, stops, `uncertain`, restarts and crashes yield
nothing. A clean finish with a spoiled recording yields the "can't be saved" notice
(below). The recording dies with the `ScreenRun` otherwise.

No `EXPECT_*` step is ever inferred: the model's `done` is not proof. An action the
user approved during the task (a held one) is recorded and **marked**; the review
screen says: "during the task this step asked for your approval; as a routine it will
not ask again — every run is still confirmed in chat".

**What the selector proves.** The uniqueness test runs on the snapshot the action used,
through the runner's own `pickTarget`/`pickField`, so on that screen the step acts on
that node and nothing else. It does not prove the app reaches that screen from a fresh
start: a task opens the app as it was, a routine opens it fresh
(`RoutineLogic.launchFlags`, `RoutineLogic.kt:212`). Hence the dry-run gate.

## Where the draft lives

`RoutineDrafts` — an in-memory holder (process lifetime), **one** draft: an `id`
(random), package, app label, steps, marks, the time it was made. It expires after
30 minutes; a newer draft replaces it. Never written to storage, sent, logged or put
in history. Save and discard act only on the draft whose `id` the review screen opened
(`take(id)` / `drop(id)`); a stale id (replaced, expired, app restarted) gets "this
draft is no longer available" and nothing is saved. The `ScreenAgentRunner.Task`
inputs stay in memory (`ScreenAgentRunner.kt:48`); the draft copies only the typed
inputs it uses, in memory. `offer` runs on the accessibility service's worker thread
(`RoutineAccessibilityService.kt:831-843`) and the rest on the main thread, so every
`RoutineDrafts` method is `synchronized` on one lock, and a draft is an immutable value
swapped whole.

## The user's flow

1. A task ends with a draft → a **local** notification (no server change, `VISIBILITY_PRIVATE`,
   no step text on the lock screen), carrying the draft `id`: "Save as a routine?" →
   `RoutinesActivity` in review mode. While the draft lives, ☰ → ⚙️ שגרות shows it at
   the top. A spoiled clean finish → a local notification "can't be saved as a
   routine: <reason>" (one fixed string per code), no button.
2. **Review screen** — the existing editor (`RoutinesActivity.edit`, `:337`) pre-filled:
   app, steps (each with the existing `describe(step)`, `:512`), an empty required name,
   the marks, and the **explanation**. Steps are edited, removed or added like any
   routine. The working copy of the steps is kept in the draft holder under its `id`
   after every edit, so a recreated activity (it is left during the dry run) restores it.
3. **Dry run** (the existing `run(routine, dryRun = true)`, `:226`: opens the app fresh,
   goes up to the first action, acts on nothing). The result intent gets one more
   extra, the `stepHash` the dry run was for. **Save is enabled only when the last
   `DRY_RUN_OK` carries the hash of the current steps**; any edit changes the hash and
   needs a new dry run. A failed dry run shows its usual reason plus "the task may have
   started on a screen other than the app's first".
4. Save → `RoutineLogic.problem` (the name included) → `RoutineStore.save` (sync of names
   and hashes, unchanged) → `drop(id)`. From then on it is an ordinary routine: named in
   chat, Tier 2, confirmed; the stored-PIN switch off (a new id, `UnlockStore`).

## The explanation (code)

`RoutineLogic.explain(routine, marks): List<Line>` returns codes; `RoutinesActivity`
renders them from `res/values/strings.xml` (the app has Hebrew strings only; written
with the `hebrew-i18n` + `hebrew-content-writer` skills at build time; Latin, numbers
and quoted texts through `Ui.isolate`):
- opening: opens app X fresh, on its first screen;
- one line per step (the existing `describe(step)`);
- ending: with a check → "says done only if …"; without → "will say tapped, not
  verified — add a check to get done";
- each marked step: the approval line above;
- fixed: runs only after you confirm in chat, up to 7 days ahead.

Shown on the review screen and, for every routine, under a "what does it do?" button
in the list. No server change, so no eval.

## Not in this plan

- "Save as a routine" from a chat sentence: needs a server tool; the notification and
  list entry cover it. The server's end message is unchanged.
- "Make it a routine" for an image (`docs/plans/image-input.md`).
- Drafting from words by a model (declined).
- Scroll or back in routines.

## Prerequisite

The recorded `TYPE_TEXT`/`SUBMIT` after a tap rely on the field anchor, whose phone
check (M4, PLAN §13) is still owed. Part 2's phone check runs after M4 passes.

## Parts (one per session)

| Part | What | Status |
|---|---|---|
| 1 | `RoutineRecording` (pure) + tests; `fire`'s read-back; capture in `ScreenRun`; `RoutineDrafts` (in memory) + tests; HANDOFF §6 line | [x] dee4a93 |
| 2 | Review mode, dry-run hash gate, notifications, list entry, `explain` + strings + tests; version bump + APK; docs | [x] 8b7de9f (app 0.21.0) |

### Part 1 — the recorder (app only)

- `RoutineRecording.kt` (pure Kotlin): `record(action, target, outcome, typedMatched,
  inputs, held)`, `finish(outcome): Draft | Spoiled(reason) | None`.
- `RoutineAccessibilityService.ScreenOps.fire`: also report the `type` read-back
  (`type(...).second == null`), used only by the recorder.
- `ScreenRun`: one `RoutineRecording`; feed it in `dispatch` after the journal outcome
  (every outcome, so a non-`DISPATCHED` one spoils it); mark held actions released by the
  user (`released`); call `finish` in `handle` on `Answer.End`, and hand the result to
  `RoutineDrafts.offer` (notifications come in part 2: part 1 only stores).
- `RoutineDrafts.kt`: in-memory, `offer`, `get(id)`, `update(id, steps)`, `take(id)`,
  `drop(id)`, 30-minute expiry via an injected clock.
- Tests `RoutineRecordingTest`: every table row; the candidate order (text before
  description before child before id); a twin label ("שמור" twice) falls to the id;
  a lender-only node refused; type with the anchor, with `pickField` only, with an
  inserted tap; an anchor on field A, then type into B (inserted tap) and submit into B
  (refused); type read-back mismatch spoils; submit without anchor or focus refused;
  scroll/back spoil; `NOT_ACCEPTED` spoils; 11 steps spoil; waits only spoil; non-clean
  outcomes give none; a draft passes `RoutineLogic.problem` once named, and its
  `stepHash` is stable. `RoutineDraftsTest`: expiry, replace, stale id refused.
- Docs: HANDOFF §6 one line (part 1 of this plan done), session-log entry.
- Verify: `./gradlew testDebugUnitTest`. Commit, push. No APK, no server deploy.

### Part 2 — review, explain, docs (app only)

- `RoutinesActivity`: review mode by draft `id`, the draft banner, Save gated by the dry
  run's `stepHash` extra (also added to `run`'s result intent), stale-id message, the
  marked-step line, "what does it do?" for every routine.
- `ScreenNotifications`: "save as a routine?" (with the id) and "can't be saved".
- `ScreenRun`/`RoutineDrafts.offer` posts them.
- `RoutineLogic.explain` + tests (line codes per routine shape).
- Strings in `res/values/strings.xml` (Hebrew via the skills, RTL isolates).
- Version bump (minor), APK to `C:\Users\tzur6\Downloads`. No server change, no deploy.
- Docs: PLAN §6.27 amendment, §6.28 "phase 3 built", §13 phone-check item and the
  decision-3 note, §14 dated line; `docs/plans/screen-agent.md:225` and `:371`;
  HANDOFF §4 (the screen-agent row) and §6; ARCHITECTURE (new files); app README.
- Phone check (owed, PLAN §13, after M4): FID "סטימצקי" → notification → review → dry
  run OK → save → "תפעיל את <name>" in chat runs it; a task that scrolled gives
  "can't be saved"; an edit after the dry run disables Save.

## Risks and limits

- A task that started mid-app: the dry run checks only the first step; a later step can
  still fail at run time (`FAILED_BEFORE_TAP`/`FAILED_AFTER_TAP`, as with any routine).
- A field that takes focus only from `ACTION_FOCUS` (the screen agent's way,
  `RoutineAccessibilityService.kt:537`) and not from a click: an inserted tap does not
  focus it and the routine stops with `field_changed`. Shown by the first real run.
- Labels that change (a date, a counter) make a fragile `TAP_TEXT`; the explanation shows
  every selector so the user can edit it.
- A draft is lost if the app's process dies before Save.

## Review log

- Round 1 (4 lenses): 0 blockers, 8 gaps, 7 nits. All gaps fixed above: the stored draft
  (now in memory, decision 3), the dry-run hash, the draft id, the clean-finish rule
  (any non-`DISPATCHED` spoils), the label candidates (no lender, no joined label),
  "same field" by binding with the runner's anchor rule, the typing read-back, the M4
  prerequisite. Nits taken: zero-action drafts, tap `seconds`, the "can't be saved"
  surface (a local notification), Hebrew-only strings, the extra doc lines, a HANDOFF
  line in part 1. The `commit()` nit is moot (nothing persisted).
- Round 2 (all 4 lenses): 2 gaps, both fixed: `RoutineDrafts` is synchronized (worker
  thread vs main thread); the `pickField` fallback applies only with no anchor, matching
  `anchoredField`. Data and blast-radius: no findings.
- Round 3 not needed: no BLOCKER or GAP left open. Rejected objections: none.
