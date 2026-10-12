# Routines — run from chat, a card like a reminder, numbers (2026-10-11)

The user's requests, after the first real FID run:
1. "בעוד 2 דקות תפעיל את פיד" from a normal chat did not work.
2. A scheduled routine shows like a reminder: what runs and when, a cancel button, and at
   the end a "done" message.
3. A number for each routine, so "תפעיל שגרה 3" says exactly which.
4. A check step for FID, so its end message says "done", not "not verified".

## Root cause of 1

`selectTools` (`src/agent/tool-groups.ts:182`): the words "בעוד 2 דקות תפעיל את שגרת פיד"
match no group except `routine`, which never narrows, so the agent gets the **full**
catalog + `routine.run` (eval: 6,318 tokens/call) — with the user's facts and history the
first call passes the 7,000 turn cap (`loop.ts:818`, `models.ts:70`), the agent fails, and
the parser fallback (whose catalog has no `routine.run`, `PARSER_TOOL_NAMES`) answered with
`reminders.cancel` → "אין תזכורות ממתינות". The chat on the phone shows exactly that.

## Changes

### A. Selection (server, `agent/tool-groups.ts`)
When `routine.run` is in `offered` (code found a routine named, `namesRoutine`) and the words
match no other group, offer `routine.run` + the `time` group (reminders and calendar: "תזכיר
לי לפתוח את פיד" still works) instead of the full catalog. Other cases unchanged.
The Groq fingerprint is unchanged: no `fingerprintPhrases` phrase names a routine, so
`routine.run` is never offered there. Unit test in `tool-groups.test.ts`; eval cases rt-006,
rt-007 (the user's words) added; `pnpm eval:agent --filter rt-` run.

### B. Numbers (app + server)
- The app shows each routine as "1. פיד" in its list order (`RoutineStore.all` order, the
  order the sync already sends). Deleting renumbers the rest (said on the screen).
- The server keeps the synced order in an explicit `position` column (migration 0029):
  `replaceNames` stores the list index; `names()` orders by position (NULL — a row from before
  0029 — last, then name; the next sync fills it). Number = position + 1. (Review: `names()`
  ordered by name, `routine-store.ts:97`; rowid order is not a contract.)
- The phone keeps a routine's place when it is edited: `RoutineStore.save` replaces in place
  (it appended, `RoutineStore.kt:30`, so every edit moved the routine to the end and renumbered).
- `findRoutine`: a variant that is only a number, or "שגרה 3" / "שגרה מספר 3" / "routine 3",
  picks that position; out of range → `routine_unknown`. Exact name still first. The confirm
  card always shows the name and app ("להפעיל את השגרה 3 · פיד באפליקציה Fid…"), so a number
  that moved after a delete is caught before anything runs; and execute re-checks the
  routine id + step hash (unchanged).
- `RoutineInput` gets an optional `number` (optional: a confirmation stored before the
  deploy has none) shown in the preview.
- The model passes the number as a `routine` variant (strings already); one sentence in the
  routine tool's slot description ("a name, or its number"). Prompt unchanged.

### C. The card in the reminders conversation (server)
- Migration 0029: `routine_runs` gets `announced_at INTEGER` and `notice_hash TEXT`.
- `AssistantDO.serviceRoutines`, first step `takeAnnouncements(now)`: runs `scheduled`, not
  announced, due more than `ROUTINE_NOTICE_MS` away → one conditional UPDATE sets
  `announced_at` and `cancel_hash = digest(nonce)`; a card goes to the reminders conversation:
  "⚙️ שגרה מתוזמנת: 3 · פיד באפליקציה Fid · יום א׳ 11.10 · 14:00" with a **ביטול** button
  (`rt:<runId>:<nonce>:no`, the existing handler). A run due sooner is marked announced with
  no card (the two-minute notice comes at once and carries the button). `execute` already
  sets `rescheduleAlarm`; `nextWakeAt` adds "unannounced scheduled runs → now".
- `takeNotices` stores its new nonce's hash in `notice_hash` instead of overwriting
  `cancel_hash`; `cancel()` accepts either hash (constant-time, both compared). So the card's
  button and the notice's button both work until the run is claimed.
- The end: unchanged paths, already to the reminders conversation as push notifications —
  `done` ("✓ … הופעלה, והאפליקציה אישרה") for VERIFIED, `unverified` etc. otherwise. The
  `done` and `unverified` texts gain the number.
- The confirm reply in the chat ("נקבע: …") says the card with the cancel button is in
  התזכורות.

### D. FID check step (on the phone, after the service is back on)
Run FID, dump the results screen, add an `EXPECT_TEXT` on a text that only the results show
(not the typed word — fields never count). Done through the app's editor, by the user or
via adb with screenshots.

## Out of scope
- Scheduled runs in `reminders.list` (its output reaches the model; routine names are
  private — a separate decision).
- The bot building routines from a request (its own plan).

## Tests
tool-groups (A), `findRoutine` numbers (B), routine-store: announce once, short-due no card,
both hashes cancel, a claimed run cannot be cancelled by either (C), migration registered;
render texts; app `RoutineLogicTest` unaffected; app list shows numbers (manual).

## Review (inline: the reviewer agent stopped on the account's spend limit)
- [consistency] `names()` sorted by name → numbers would not match the phone → `position` column.
- [consistency] the phone's save appended an edited routine → renumbering → save in place.
- [data] a pending confirmation without `number` → optional field.
- [concurrency] announce (due − now > notice window) and notice (≤) are disjoint at one `now`;
  cancel stays one transaction checking status, now against either hash.
- [data] runs scheduled before 0029 have `announced_at` NULL → they get their card on the next
  alarm (wanted).
- [blast-radius] ARCHITECTURE tables row, PLAN §6.27/§14, HANDOFF migration number.

## Rejected objections

None.
