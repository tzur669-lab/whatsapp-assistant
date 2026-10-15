# Screen agent ("סוכן מסך") — build spec

The reviewed plan (eight review rounds, the user's decisions of 2026-10-12)
is in the second half of this file, unchanged. The first half is the build
spec both sides are written against: the wire protocol, the element format,
the binding, the risk policy and the journal. Where the two differ, the
"Deviations" list says why.

Status (2026-10-12): phases 1 and 2 are being built. Phase 3 ("save as a
routine") needs its own reviewed plan first. The smaller MobileAgent ideas
are not part of this build.

## A. Constants (both sides)

| Name | Value | Where |
|---|---|---|
| `MAX_STEPS` | 12 model steps per task | server decides, phone also counts |
| `TASK_DEADLINE_MS` | 4 min from the claim | server stores `deadlineAt`, phone gets it in the claim |
| `APPROVAL_TTL_MS` | 2 min (never past the deadline) | server |
| `CLAIM_TTL_MS` | 2 min from the confirmation's push | server |
| `MAX_ELEMENTS` | 80 | phone caps, server refuses more |
| `MAX_LABEL` | 80 chars for `t`, `h`, `v` each | phone cuts, server refuses longer |
| `MAX_SCREEN_CHARS` | 2,500 chars (`t`+`h`+`v` of all elements) | phone stops adding elements, server refuses more |
| `MAX_WAITS` | 6 lock waits per task, each 2–15 s | server |
| `MAX_INPUTS` / `MAX_INPUT` | 3 inputs of ≤60 chars | server |
| `MAX_TASK` | 200 chars | server |
| `MAX_APPS` | 20 allowlisted apps | both |
| `TASKS_PER_DAY` | 10 (Asia/Jerusalem day; 3 until 2026-10-13) | server |
| `TASK_TOKEN_CEILING` | 18,000 tokens (reservation limit) | server |
| `STEP_MAX_COMPLETION` | 150 tokens | server |
| `ROUTINE_GUARD_MS` | 7 min: no task when a routine run is due sooner | server |

## B. FCM data pushes (high priority)

| `kind` | data | phone does |
|---|---|---|
| `screen` | `task_id` (32 hex) | unlock if needed (`RoutineRunActivity`), then claim |
| `screen_release` | `task_id` | wakes the approval wait at once (it polls `/step` `poll`) |
| `screen_stop` | `task_id` | sets the task's stop flag (the task ended on the server) |

A routine push (`kind: routine`) also sets the stop flag of any running task.

## C. Routes (signed, `POST`, `application/json`, app channel only)

Order in the DO as every app route: signature → nonce → strict Zod → handler.

### `/app/screen/allow` (≤ 4 KB)
`{"apps":[{"package":"il.co.fid","label":"FID","askEveryTap":false}]}` (≤20).
Replaces the server's `screen_allow` as a whole. A non-final task whose
package is no longer listed ends at once (`app_removed`) and its pending
approval is void. Answer `{"status":"ok"}`.

### `/app/screen/claim` (≤ 1 KB)
`{"taskId":"<32 hex>"}` →
- `{"status":"ok","package":"…","label":"…","task":"…","inputs":["…"],"deadlineAt":<epoch ms>,"maxSteps":12}`
- `{"status":"refused","reason":"not_found|already|late|stopped|not_allowed"}`

Once only (conditional `UPDATE pushed → running`). The inputs travel only here.

### `/app/screen/step` (≤ 16 KB)
Three request kinds (`kind`):

```jsonc
// A new screen for step N (1..12). N = 1 has no report; N > 1 must report step N-1's actionId.
{"kind":"screen","taskId":"…","step":3,
 "screen":{"hash":"<64 hex>","elements":[El, …]},
 "report":{"actionId":"<32 hex>","status":"dispatched|not_accepted|refused|uncertain","reason":"<code>"}}
// Waiting on an approval: no model call, the stored state for step N.
{"kind":"poll","taskId":"…","step":3}
// The phone classes step N's stored action higher than the server did (§3 of the plan).
{"kind":"hold","taskId":"…","step":3,"actionId":"…","cls":"uncertain|sensitive","why":"<why code>"}
```

`El` (element): `{"i":0,"t":"label","h":"hint","v":"view_id","c":"Button","f":"ce","b":"<32 hex>"}`
- `i` 0..79, in list order, unique; `t`, `h`, `v` optional, ≤80 chars; `c` the
  class's simple name, optional, ≤40 chars, `[A-Za-z0-9_.$]`.
- `f` flags, each letter at most once, in this order: `c` clickable, `e`
  editable, `s` scrollable, `k` checkable, `x` checked, `d` disabled, `o` focused.
- `b` the binding: present exactly when `f` has `c`, `e` or `s`.

Answers (`status`):

| status | body | phone does |
|---|---|---|
| `act` | `step, actionId, action, cls:"safe"` | journal `new → started → …`, perform, report on step N+1 |
| `approval` | `step, actionId, action, cls, why, nonce, expiresAt` | journal `held`, notification, wait (push or poll) |
| `released` | `step, actionId, action, grant:{taskId,step,actionId,binding,package,maxClass,expiresAt}` | `held → started` once, after fresh checks |
| `wait` | `retryAfterMs` (2,000–15,000) | sleep, send the same step again (no report change) |
| `end` | `outcome` | stop quietly; the chat message comes from the server |
| `stopped` | `reason` | stop quietly |

`action` is one of `{"kind":"tap","b":…}`, `{"kind":"submit","b":…}`,
`{"kind":"type","b":…,"input":1..3}`, `{"kind":"scroll","b":…,"dir":"fwd|back"}`,
`{"kind":"back"}`, `{"kind":"wait","s":1..5}`. A retry of step N gets the
stored answer with the same `actionId`.

### `/app/screen/approve` (≤ 1 KB)
`{"taskId":"…","actionId":"…","nonce":"<32 hex>","verdict":"yes|no"}` →
`{"status":"released|rejected|already"}`. The same row and nonce as the chat
card's `sa:<taskId>:<nonce>:ok|no`; the first decision wins.

### `/app/screen/result` (≤ 1 KB)
The phone ends a task by itself: `{"taskId":"…","reason":"<end code>","report":{…}?}`.
End codes: `stopped_user`, `stopped_restart`, `locked`, `app_missing`,
`app_not_front`, `launch_confirm`, `left_app`, `service_off`, `deadline`,
`step_limit`, `not_allowed`, `screen_changed`, `target_ambiguous`,
`uncertain`, `unreachable`, `error`. Answer `{"status":"ok"}`.

## D. Elements (phone, `ScreenLogic.elements`)

From the flattened tree (`RoutineLogic.Node`, now with `className`, `path`,
`windowId`, `scrollable`, `checkable`, `checked`), visible nodes only, in tree
order:
1. An **actionable** node (clickable, editable or scrollable) is an element.
   Its `t` is its own text, else its description, else the text of the
   non-actionable nodes under it whose click target it is, joined by " · ",
   cut to 80.
2. A non-actionable node with text or description that is under no
   clickable ancestor is a **read-only** element (no `b`).
3. Elements stop at 80, or before the total of `t`+`h`+`v` passes 2,500.
4. `v` is the part after `:id/`.

`usable(list)`: false when no element is clickable **and** labelled (`t` or
`v`). The server applies the same rule to what it receives.

## E. Binding (phone only; the server echoes it)

`sha256( "v1" US pkg US windowId US path US className US editable US clickable US checkable US checked US viewId US hint US desc US textPart )`,
first 32 hex chars; `US` = `\u001f`; booleans `1`/`0`; nulls empty;
`textPart` = the node's own text, or empty for an editable node (its
hint + view id + path name it, so typing does not break it). `enabled`,
`visible`, `password` are not in it; they are checked at dispatch.

Resolve before acting: a fresh snapshot of the same package, nodes whose
binding equals the stored one: exactly one → act (after `click()` /
`fieldUsable()` checks); none → `screen_changed`; several → `target_ambiguous`.

## F. Risk policy (`test/fixtures/screen-policy.json`)

`normalize(s)`: NFC; drop `[​-‏‪-‮⁦-⁩﻿]`
and niqqud `[֑-ׇ]`; a space between a lowercase and an uppercase
letter (camelCase); every run of characters that is not a letter or digit
becomes one space; trim; lowercase. Tokens: split on the space.

- Hebrew word (has a letter in `֐-׿`): matches when the
  normalized string contains it. Latin word: when a token starts with it.
- Generic words: when a token equals the word, or (a phrase) the normalized
  string equals it.
- Search words: as sensitive matching, over `h`, `v` and `t`.

`riskClass(action, el, ctx{askEveryTap, typedNonSearch})`, first match wins:
- `scroll`, `back`, `wait` → `safe`.
- `type` → `uncertain/ask_every_tap` when `askEveryTap`, else `safe`.
- `tap` / `submit`:
  1. a sensitive word in `t` or `v` → `sensitive/sensitive`
  2. `askEveryTap` → `uncertain/ask_every_tap`
  3. `tap` with no `t` and no `v` → `uncertain/unlabelled`
  4. a generic word in `t` or `v` → `uncertain/generic`
  5. `submit` on a field that is not a search field → `uncertain/submit_not_search`
  6. `tap` on a non-editable element after `typedNonSearch` → `uncertain/after_form`
  7. → `safe`

`typedNonSearch`: some earlier `type` in this task went into a field that is
not a search field. The higher class always wins (`safe < uncertain < sensitive`).

## G. The phone's journal

SharedPreferences, `commit()` per move, holds `taskId`, `actionId`, status
only. Moves (plan §9.9): `new→started` (safe), `new→held`,
`new→refused`, `held→started` (once, valid grant), `held→refused`,
`started→dispatched|not_accepted|uncertain`. Final: `dispatched`,
`not_accepted`, `refused`, `uncertain`. At process start: every `held` →
`refused` and reported `stopped_restart`; every `started` → `uncertain` and
reported `uncertain`.

## H. Server statuses (`screen_tasks.status`)

`confirmed → pushed → running ⇄ awaiting_approval → released → running …`,
final: `stopped`, `preempted`, `deadline`, `done`, `failed`, `unknown`.
Each move is one conditional `UPDATE`. Outcomes shown to the user:
`completed_unverified`, `inconclusive`, `failed_before_action`,
`failed_after_action`, `unknown`.

## Deviations from the reviewed plan

- `/step` cap is 16 KB, not about 8 KB: 80 bindings of 32 hex characters plus
  2,500 characters of Hebrew (two bytes each) do not fit 8 KB.
- The approval nonce is kept as is in `screen_tasks`, not as a hash: a lost
  `approval` answer must be answerable again with the same nonce, and the
  chat card in the outbox holds the same nonce anyway.
- The stop button is `ss:<taskId>:<nonce>:no`; its nonce is kept as is too.
  It can only stop a task.
- Past steps reach the step model as codes ("tap → done"), never as the
  label of what was tapped: no screen text is kept between steps. A `type`
  step names its input's number ("type input 1 → done", 2026-10-14).
- The step model answers with one JSON object as text, not a tool call.
- The agent eval cases are `scr-` (`sc-` already prefixes other cases).
- A report's `reason` is the closed list `screen_changed`, `target_ambiguous`, `tap_refused`, `not_allowed`, `left_app`, `stopped`, `error` (`stepReportSchema`); the phone maps its own codes onto it. The end codes of `/result` are the list in section C.
- An `approval` answer is never sent without its nonce: a card with none answers `stopped`.

---

# The reviewed plan (2026-10-12)

## Context

The user asked for a review of [GiggleWang/MobileAgent-Android](https://github.com/GiggleWang/MobileAgent-Android) (MIT, Kotlin) and for ways to improve the bot from it. The main goal is a bot that **sees the screen and acts on it while following an instruction** ("open FID and find סטימצקי", "in the attendance app check whether I punched in"). Everything has to stay free.

**What MobileAgent does:** an AccessibilityService plus MediaProjection screenshots. Elements are drawn as numbered boxes on the image and sent to a paid vision model (GPT-4o or Claude). A loop of Manager (plan), Executor (one action), Reflector (before/after compare) and Notetaker runs for up to 25 steps. Actions are tap(x,y), long_press, swipe, type, back/home/enter, wait, answer and finished. It has a floating status window and step logs, and **no confirmations and no app limits**.

**What the bot already has:** `RoutineAccessibilityService.kt` already reads the screen. `snapshot()` flattens the accessibility tree into `RoutineLogic.Node`. The service taps, types and submits with re-checks before every action: unlocked, same package, visible, enabled, not a password field. What it lacks is a model in the loop. Today routines are fixed and "never written by a model" (PLAN §6.27).

**The user's decisions (2026-10-12):**
1. The model sees the **accessibility tree as text**: a numbered element list passed through `scrubForModel`. No screenshots. Groq models only, never Gemini. *2026-10-13: a task confirmed in a smart conversation uses Gemini only — `docs/plans/screen-model-by-mode.md`.*
   - **The data flow, stated exactly:** the **raw** element text leaves the phone over TLS, signed, and reaches only the bot's own Worker and Durable Object. There it lives in memory for one request: never persisted, never logged. Inbound records keep ids and times only.
   - Only the **scrubbed** text goes on to Groq, which is a **hosted** service, not on-device.
   - Phone reads such as notifications already work this way: raw to the Worker, scrubbed before any model sees them. Scrubbing on the phone was rejected because a Kotlin copy of `scrubForModel` would drift from the original.
2. The agent acts **only in apps on an allowlist the user approves on the phone**. Never in banking, settings, messaging or the lock screen.
3. **One approval per task, plus a code-decided stop before any sensitive or uncertain action.** A stop button is always visible.

These decisions amend invariants. Each amendment needs a dated PLAN §14 line and a CLAUDE.md edit in the same commit:
- **Inv. 2:** a new data path, the screen. It is scrubbed, capped, always tainted, sent to Groq only, and it is **not** a `DataSource`.
- **Inv. 3/5:** the model picks an index into a code-built list. The phone resolves the target by its own binding, never by the index.
- **Inv. 10:** one confirmed task becomes a capped multi-step run on the phone.
- **PLAN §6.27:** "never written by a model" still holds for routines until phase 3. *Amended 2026-10-15 by phase 3 (`docs/plans/routine-from-screen-task.md`): phone code may write a routine's steps from the actions a confirmed task ran; only the user saves it.*

## Design

**The loop runs on the server, and the phone is only eyes and hands.** The Groq key, `scrubForModel`, the Zod schemas, policy and the budget all stay where they already are. The phone never holds a key, and the phone has the last word on every action.

```
"תחפש בפיד סטימצקי" → agent picks screen.task (Tier 2, offered only when named)
  → confirm card: the app, the task, and the exact texts it may type → tap ✓
  → FCM {kind: screen, task_id} → phone claims (signed, once, like the routine claim)
  → bootstrap in code: the existing open() opens the approved package, then verifies it is in front
  → loop on the phone, at most 12 steps and 4 minutes:
       snapshot() → element list (≤80 elements, ≤2.5K chars), each with the phone's own binding
       → signed POST /app/screen/step {task_id, step N, nonce, elements, report of N-1}
       → DO: usable tree? → scrubForModel → one Groq call → strict Zod
             → code policy (risk class, typing by input number) → action {actionId, binding}
       → phone: stop flag? journal? allowlisted window? resolve binding → exactly one node? → performs
  → done/fail/ask → one code-rendered reply in the chat (codes + the model's capped summary)
```

**Closed action schema** (Zod `.strict()`, discriminated union):
- `tap{i}` · `type{i, input: 1..3}` · `submit{i}` · `scroll{i, dir: fwd|back}` · `back` · `wait{s ≤ 5}`
- `done{summary ≤ 200}` · `unsure{summary ≤ 200}` · `ask{question ≤ 200}` · `fail{reason: closed enum}`

There are no coordinates, swipes, home button or app switching. `back` is performed first and then checked: if the window it leads to is off the allowlist, the task ends with `left_app`.

### 0. Opening the app

The model never switches apps. After the claim, code opens the approved package with the routines' existing path.

- **The launch:** `RoutineAccessibilityService.open()` runs from the bound AccessibilityService. It gets a parameter `fresh: Boolean`:
  - **Routines keep `fresh = true`** (`NEW_TASK|CLEAR_TASK`). That was a deliberate fix, because FID had been left on a results page with no field.
  - **Screen tasks use `fresh = false`** (`NEW_TASK` only). That brings the app to the front as it was, so the user's place and any unsaved work in it survive. The agent reads whatever screen it finds and can tap back.
  - Routines behave exactly as before, and a test pins that. Android's background-activity-launch rules exempt apps with a system-bound accessibility service, and routines already open FID and the attendance app this way on the user's phone.
- **Waiting for the user:** while the phone's "allow opening?" dialog is up, `open()` already waits up to `CONFIRM_WAIT_MS`.
- **A locked phone:** `RoutineRunActivity` (`requestDismissKeyguard`) is reused, as for routine pushes.
- **The loop starts** only once `snapshot(package)` is non-null, meaning that package is in front and the phone is unlocked.
- **Failures** use the existing codes and are reported, with nothing tapped: `app_missing`, `app_not_front`, `launch_confirm` (the reply tells the user to allow opening, or to open the app and say "נסה שוב"), and `locked`.
- **Tests:** the companion app in front; the target in the background (it comes back on the screen it was showing); the target not installed. Routines keep `CLEAR_TASK`.

### 1. At-most-once execution

**The guarantee:** each action runs **at most once**. Exactly-once cannot hold across a lost response plus a crash. If the phone cannot tell whether an action ran, the task stops and the user is told. It is never repeated.

- The server gives each decided action a random `actionId` and stores it under step N.
- The phone keeps a small **journal** in its own app storage (synchronous `commit()`, like the routine run state). It stores only the taskId, actionId and status, never screen text. The full state machine is in section 9.9. `dispatched` only means Android accepted the call, not that the goal was reached.
- Before performing an action, the phone writes `started actionId`. After performing it, the phone writes the outcome.
- A retry of step N returns the stored action with the same `actionId`:
  - If the journal shows a final state (`dispatched`, `not_accepted` or `refused`), the phone does not act. It reports the stored outcome.
  - If the journal shows it `started` with no outcome, the action **may have run**. The phone does not act, reports `uncertain`, and the task ends as `unknown`, the same as `FAILED_AFTER_TAP` for routines.
- After a process restart, any journal entry left at `started` is reported as `uncertain` with the next sync, and that task is closed.
- The server accepts step N+1 only with a report for step N's `actionId`. A `wait` reply is never stored as step N's action.
- Server side, each status move is one conditional `UPDATE`.

### 2. Node binding

`RoutineLogic.Node` has no class name and no tree position today, so `snapshot()` adds `className`, `path` (the chain of child indexes from the root) and the window's `windowId`.

For each element, the phone computes a **binding** (section E above, extended in 9.6), taken from the full, uncapped node. The binding is sent with the element and echoed back by the server for the chosen index. The server never recomputes it.

Before acting, the phone takes a fresh snapshot and looks for nodes with that binding. It acts only when **exactly one** matches, and then only after the existing `click()`/`fieldUsable()` checks. No match → `screen_changed`. Two or more → `target_ambiguous`. A new activity changes `windowId`, so a window change always refuses.

The index is used only on the server, inside the same list it received. Capping and scrubbing change the text the model sees, never the binding.

### 3. Risk policy in code, conservative by default

Before a `tap` or `submit`, code (on both server and phone, with shared test vectors) sorts the target into `sensitive`, `uncertain` or `safe` (section F above). The model's own view is never consulted. Sensitive and uncertain both **stop and ask**. Every approval goes through the server:
- **On the phone:** a local, high-priority notification built on the phone from the full node: the app, the action, the target's own label, **why** it asks ("נראה כמו שליחה/תשלום/מחיקה", "כפתור כללי — ייתכן שזה שולח טופס", "כפתור בלי שם", "אחרי מילוי שדה"), and which approved input, if any, was typed. Its "אשר"/"דחה" buttons send a signed `/app/screen/approve`.
- **In the chat (a minimal card):** the app label, the action type and the reason class only. No screen text. The same approve/reject, bound to the same `actionId`.

Each allowlisted app also has a per-app setting, "לשאול לפני כל לחיצה", off by default.

**When the two sides disagree, the higher risk class always wins.** If the phone classes a target higher, it journals `held` and reports `hold`; the server moves the task to `awaiting_approval` for that same stored action. An approval is one conditional `UPDATE` `awaiting_approval → released` `WHERE actionId = ? AND status = 'awaiting_approval' AND deadline > now`. The phone then moves `held → started` once, after fresh checks (stop flag, allowlist, exactly one binding, risk class ≤ `maxClass`). Rejection, a 2-minute timeout, a duplicate card request and a repeated approval tap all end the task or do nothing, safely. **Drift:** each side keeps its word lists in code; `test/fixtures/screen-policy.json` is checked by a test on each side.

### 4. Typing only approved inputs

`screen.task` gets a slot `inputs` (≤3 strings, ≤60 chars each), filled by the agent from the user's message.
- In `resolve`, code checks that each input is a normalized substring of the **raw** user message (NFC, invisible characters removed, spaces collapsed, niqqud dropped).
- The confirm card lists the inputs word for word.
- The step model sees only "קלט 1/2/3" with the scrubbed value; when scrubbing changes a value, only the placeholder.
- The model's action is `type{i, input: k}`. **The phone types the stored value**.
- The main chat model sees the user's whole message, inputs included (the user's own text, inv. 2). The privacy claim applies only to the **screen-step model**.
- Inputs are kept encrypted in `screen_tasks`, travel to the phone only in the signed claim response, and are cleared when the task ends. The phone keeps them in memory only.
- There is no free-text field in the action. `refusesTainted` keeps shared or forwarded text from starting a task.

### 5. Cancellation, preemption and the lock

- **The dispatch boundary:** `synchronized(gate) { if (stopped) refuse; journal started; performAction; journal outcome }`. Stop sets the flag inside the same `gate`. Once `stop()` returns, no new action starts. Screen tasks and routines share one worker thread. Step requests have connect and read timeouts (step ≤ 30 s).
- **The stop flag:** `@Volatile`, per taskId, set by "עצור", the routine push or a server `stopped`; checked before every action, inside every wait loop (each 250 ms) and right after each `/step` returns.
- **An in-flight `/step` request** is aborted with `HttpURLConnection.disconnect()`; any answer for a stopped task is ignored.
- **A preempted task:** the server marks it `preempted`; any later `/step` gets `stopped`. The routine runs as soon as the task's loop exits.
- **`wait`** carries `retryAfterMs` = the lock's remaining TTL, clamped to 2–15 s; one request per wait; at most 6; `busy` when the lock outlasts the task's deadline.
- **Chat during a task:** a code reply, "סוכן המסך עובד עכשיו", with a "עצור" button and no model call.
- **Routines first:** a task is refused when a routine run is due within 7 minutes.

### 6. Budget

- Per step about 1.5K tokens (1.1–1.3K measured on qwen, 2026-10-14; a corrective call about doubles its step); a 12-step task at most about 24K.
- Each task has a ceiling of **24K measured tokens** (a reservation limit; 18K with `max_tokens` 150 until 2026-10-14, when qwen's thinking was cut off): before each step the reservation (estimated prompt × 1.3 plus `max_tokens` 1,024) must fit in what is left; a step's one corrective call (2026-10-14, PLAN §6.28) reserves the same way; after it, measured usage replaces the reservation; a failed or 429 call is charged its reservation. The measured total can pass 18K by one call only (worst case: the prompt's UTF-8 byte count plus 150).
- At most **10 tasks a day** (Asia/Jerusalem day; 3 until 2026-10-13). A task ends `quota` only when every model of its family is out for the day.
- `SCREEN_MODELS` starts as qwen; moving to a second Groq model only after a human reads its `eval:screen` report. *2026-10-13: the user added gpt-oss-120b and the Gemini list before that read (PLAN §14).*

### 7. Thin trees and the full privacy path

- **`tree_unusable`** (a heuristic): only a list with **no labelled clickable element at all**, with no model call. A thin but usable screen still goes to the model, which may answer `fail{cannot_see}`.
- **`no_effect`** (a heuristic): three unchanged screen hashes in a row end the task with "לא ראיתי שינוי במסך"; counted as `unknown`.
- **A deadline or step limit during a card or a `wait`:** `deadline`, the card expires, nothing more is dispatched.
- **Privacy:** screen text reaches only the step prompt; errors pass through `errorCodeOf`; Zod issues are never logged; the step route has a log canary; nothing goes to history, `last_exchange`, `misses` or the outbox except the code-rendered reply and the model's capped strings, scrubbed again and link-defanged.
- **Disclosure** on the allowlist screen: "טקסט שמופיע באפליקציה הזו נשלח לשרת של הבוט, ואחרי ניקוי של מספרים, קישורים ומיילים, לשירות Groq. הניקוי לא מסיר כל פרט אישי."
- **Turning an app off** stops a running task in it at once; the server ends it and voids its pending approval.

### 8. Result wording and the joint state machine

`done` never gets "✓ בוצע". The reply reads "לפי מה שראיתי על המסך: <summary>", then the code-rendered steps taken, and "לא אימתתי" when a step went unchecked. `unsure` → "לא הצלחתי לקבוע". Outcomes: `completed_unverified`, `inconclusive`, `failed`, `unknown`.

Server statuses: `running`, `awaiting_approval`, `released`, final `stopped`, `preempted`, `deadline`, `done`, `failed`, `unknown`. Stop, preemption, the deadline and an allowlist removal move any non-final status to a final one; an approval only moves `awaiting_approval → released`.

| Case | Result |
|---|---|
| Approve and Stop at almost the same moment | Stop first → the approval finds a final status. Approval first → the phone's gate checks the stop flag before `held → started`. |
| Approval after the deadline | `deadline > now` fails, nothing runs. |
| The window or the binding changed while the card was open | `refused`, the task ends. |
| Approved, but the phone was offline | `/step N` when back: the release before the deadline, else `deadline`. |
| The phone restarted while `held` | `held → refused`, `stopped_restart`; a later approval does nothing. |
| A routine push while awaiting approval | Stop flag, `preempted`; the routine runs. |
| The approval tapped twice | The second `UPDATE` matches no row. |

### 9. Approval mechanics

- **9.1 Grant:** `grant{taskId, step, actionId, binding, package, maxClass, expiresAt}`; at `held → started` the phone's class must be ≤ `maxClass`; used once.
- **9.2 `askEveryTap`:** the phone's own setting decides; the server's copy only asks early.
- **9.3 One approval row**, one nonce, two buttons (`sa:` in chat and `/app/screen/approve`); first wins, the other gets "כבר הוחלט". One notification per `actionId`, cancelled on any outcome.
- **9.4 Lock screen:** `VISIBILITY_PRIVATE`, public version "סוכן המסך מבקש אישור"; inputs shown as "קלט 1"; `setAuthenticationRequired(true)` on Android 12+.
- **9.5 Restart while waiting:** `held → refused`, `stopped_restart`; the server moves `awaiting_approval|released → stopped`; "המשימה נעצרה; הפעולה הזו לא בוצעה". A `started` left by a crash → `uncertain`, "ייתכן שבוצעה".
- **9.6 Binding:** adds `hint`, `checkable`, `checked`; editable nodes use `hint + viewId + path` instead of `text`.
- **9.7 Polling:** lock wait ≤6 × 2–15 s; approval wait woken by FCM `screen_release`, with backup polls at 3, 5, 8, 10, 10… s.
- **9.8 Wording:** `failed_before_action` (nothing dispatched) and `failed_after_action` ("ייתכן שחלק מהפעולות בוצעו" + the dispatched steps); `unknown` when the last action may have run.
- **9.9 Journal** (section G above). Every row tested on both sides.
- **9.10 Model strings** (`done.summary`, `unsure.summary`, `ask.question`): cap 200 → `scrubForModel` → `defangLinks`, shown as a quotation, never parsed, never logged; a canary test covers all three.
- **9.11** The package, task text and inputs are written once at confirmation; `/step` and `/result` accept no inputs from the phone.
- **9.12** Tests only: an accepted action with no change (`no_effect`), a stop after a consequential action (`failed_after_action`), a `done` that does not answer (`completed_unverified` wording).

## Phases

- **Phase 1, phone (app 0.14.0):** `ScreenLogic.kt`, `Node` + `snapshot()` fields, the service's binding resolution, `scroll()`/`back()`, allowlist in `applyPackages()`, `open(fresh)`, `screenTask(...)` on the one worker; `ScreenAgentRunner.kt`; the allowlist screen (☰ → ⚙️ סוכן מסך); `Protocol.kt` vectors.
- **Phase 2, server:** migration `0030_screen_tasks.sql`; `src/tools/screen.ts` (`screen.task`, Tier 2, private, `refusesTainted`, offered only when named); `src/agent/screen-step.ts`; routes; `render/screen.ts`; evals `cases.screen.yaml` and `pnpm eval:screen`; CPU time of one `/step`.
- **Phase 3, "save as a routine":** built 2026-10-15 (app 0.21.0, phone only), plan `docs/plans/routine-from-screen-task.md`.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; `./gradlew testDebugUnitTest`; `pnpm eval:agent --filter scr-` and `pnpm eval:screen` with a human read of both; a staging deploy (with approval) **before** the APK; then on the phone: FID "סטימצקי" reaches `done`; "שלח" and "המשך" each stop with a card; "עצור" stops; airplane mode mid-step gives `unknown` with no second tap; an app off the allowlist is refused; a locked phone gives `blocked`.

## Known limitations

- A sensitive word in a harmless label stops needlessly.
- An `uncertain` action needs the user to check by hand.
- Screens with no accessibility text cannot be used.
