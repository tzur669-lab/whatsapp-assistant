# Routines: unlock the phone with a stored PIN (app 0.17.0)

The user's request (2026-10-13): a scheduled routine should run with the phone
locked by a PIN, with no finger — the app keeps the PIN and enters it itself.
The PIN must never leave the phone (not the server, not GitHub, not the AI
session). This reverses PLAN §6.27 "it never touches the lock screen" for
routines only; recorded in PLAN §14.

**Invariant 6** ("never implement … secret access") is about tools and tiers:
this is not a tool, has no tier, is not reachable by any model or message,
and the secret never leaves the phone. PLAN §14 says so explicitly.

## Scope

- **Routines only.** Screen tasks (§6.28) keep today's flow
  (`requestDismissKeyguard`: Extend Unlock or a finger): a model-driven task
  never unlocks the phone.
- **App only.** No server change, no migration, no new reason code, no
  deploy. A failed unlock is reported as today's `blocked`/`locked`, which the
  server accepts from `claimed` (`routine-store.ts:388`).

## Gates (all in code, on the phone)

1. A PIN is stored and decrypts, and auto-unlock is not switched off by a
   failure. Any decrypt failure (key or blob missing, restore, clear data) →
   `clear()`, treated as "no PIN"; never thrown on FCM's thread.
2. The routine has its own opt-in, off by default, stored as **(routine id,
   step hash)** in `UnlockStore`: editing the steps turns it off (the switch
   shows off again); `RoutineStore.delete` drops it.
3. **The claim comes first.** With a PIN stored and the phone locked, the
   runner claims before unlocking: only a run the server confirmed, pushed and
   still on time can unlock. The claimed routine must exist with the confirmed
   step hash (else `changed`, as today) and be opted in.
4. **One attempt, ever, until the user saves the PIN again.** Before the first
   key, an `attempting` marker is written with `commit()`. Unlocked within 5 s
   of the last key → marker removed. Still locked → `failed` set. A marker
   found later (the process died mid-attempt) counts as `failed`. A changed
   PIN never burns the lock screen's attempts.
5. Android 9+ only (`GLOBAL_ACTION_LOCK_SCREEN`).
6. **Lock again** on the worker, as the job's last action, only when this job
   typed the PIN and no other job is queued.

## Flow (one owner: `RoutineRunner`)

`onPush`: service off → `blocked`/`service_off` (as today). Not locked, or no
usable PIN → today's path, unchanged. Locked with a usable PIN →
`claimFirst` on a background thread:

1. Claim (as `claimAndRun` does). Refused/unreachable → return (server tells
   the user, as today). Routine missing or hash differs → `changed`.
2. **Not opted in** → start `RoutineRunActivity` in **claimed mode**: today's
   screen-on + `requestDismissKeyguard` + 2-minute wait, but on success it
   calls the new `RoutineRunner.runClaimed(routine, runId)` — never a second
   claim — and on failure `lockedOut` (accepted after a claim).
3. **Opted in** → start `RoutineRunActivity` in **pin mode** (screen on over
   the lock screen, `requestDismissKeyguard` so the bouncer is up; no timer,
   **never reports**; it stays until the runner closes it, or 60 s as a
   safety). Then one worker job `RoutineAccessibilityService.unlockAndRun`:
   if the phone is already open when the job starts (a run before it in the
   queue, or a finger), it types nothing, runs the steps and never relocks;
   else wait ≤10 s for the keypad → map every digit (any miss → `no_keypad`,
   nothing typed) → marker → type → ≤5 s for `!locked()` → run the routine's
   steps exactly as `execute` does → relock (gate 6). The runner reports the
   result, closes the activity.
   - `no_keypad`: nothing typed, no `failed` flag; reported `blocked`/`locked`.
   - `still_locked`: `failed` set; reported `blocked`/`locked`; a local
     notification says auto-unlock turned itself off and why.

The unlock waits in line on the single worker like any job; the 10 s/5 s
windows start only when the job starts, all within the server's 10-minute
claim limit (`ROUTINE_STALE_CLAIM_MS`, `routine-store.ts:41`). Keys are read
through `getWindows()` (`flagRetrieveInteractiveWindows`), which the
`packageNames` filter does not limit, so a package refresh during the unlock
is harmless.

## Files

- `UnlockLogic.kt` (pure, unit tested): `pinProblem(pin)` (4–16 digits);
  `keyFor(digit, keys)` — view id ending `/key<d>`, else whole text or the
  first token of the content description equal to the digit; none or several
  → null (a scrambled keypad works); `enterKey(keys)` (`/key_enter`, optional);
  `decide(...)` → the gate decision.
- `UnlockStore.kt`: Keystore AES-256-GCM key (no user auth — it must work
  while locked), ciphertext + IV written in one `commit()` to private prefs
  `routine_unlock` (excluded from backup), opt-ins, `attempting`, `failed`.
  The PIN is a `CharArray`, zeroed after use; never logged, shown or sent.
- `RoutineAccessibilityService.kt`: `unlockAndRun`, `relock()`; a key is
  `ACTION_CLICK`, and only if that returns false a tap gesture at the key's
  centre — the only `dispatchGesture` and the only `GLOBAL_ACTION_LOCK_SCREEN`
  in the app; a pending-job counter for gate 6; class doc rewritten.
- `routine_service.xml`: `flagRetrieveInteractiveWindows`,
  `canPerformGestures="true"`; its comment rewritten.
- `RoutineRunner.kt`: `claimFirst`, `runClaimed`; header rewritten.
- `RoutineRunActivity.kt`: claimed and pin modes; header rewritten.
- `RoutineStore.kt`: delete drops the opt-in.
- `RoutinesActivity.kt` + `strings.xml`: set / replace / remove the PIN
  (typed twice, `numberPassword`), the risks, the failure note, a per-routine
  switch; amend `strings.xml:188` and `:193` (they say the routine does not
  touch the lock screen). Hebrew through the Hebrew skills.
- Tests: `UnlockLogicTest`; a source scan test that `dispatchGesture` and
  `GLOBAL_ACTION_LOCK_SCREEN` appear only inside the unlock functions.
- Version 0.17.0 (code 29). Docs: PLAN §6.27 (lines 2128, 2134, 2142), §13
  (the owed phone check, line 3008), §14; HANDOFF §1/§6/§8; ARCHITECTURE;
  app README (lines 224, 233, 257).

## Risks accepted by the user

- The PIN can be decrypted by the app while the phone is locked, so it is
  weaker than the lock itself (root, a malicious build of this app).
- A run unlocks the phone even if it is in someone else's hands at that time.
- A compromised server could schedule a run of an opted-in routine and so
  unlock the phone (it cannot read the PIN).
- Whether this phone's lock screen lets an accessibility service press its
  keys is known only on the phone.

## Checks

- `./gradlew testDebugUnitTest`.
- On the phone (owed): an opted-in routine with the screen off and a PIN
  lock; a wrong stored PIN turns the feature off after one attempt; relock.

## Review

Two rounds (plan-review): round 1 — the fallback claimed twice (blocker),
the activity's timer could report a running run, relock could cut the next
job, a crash between key and flag, opt-in survived a step edit, disclosure
strings, invariant 6. Round 2 — an already-open phone was reported locked.
All fixed above. Rejected objections: none.

## After the first phone run (0.17.1)

On the user's OnePlus PJE110 (ColorOS 14) 0.17.0 typed nothing: the
pin-mode screen, shown over the lock screen, occluded it, and ColorOS raises
no keypad for `requestDismissKeyguard`. The keypad, read with `uiautomator`:
ten clickable views with the digit as their description only, no ids, no
Enter. Fix: the pin-mode screen turns the screen on and steps back behind the
lock screen; the service swipes up (at most twice) until the keypad is there;
a clickable match wins over a plain label.

## 0.17.2 and 0.17.3 — the full run passes

- 0.17.2: the swipe was too short (80% → 30% of a height without the bars;
  1766 → 662 px only showed ColorOS's "swipe up" hint). Now 85% → 15% of the
  full screen height, 250 ms; checked with `adb input swipe` first.
- 0.17.3: ColorOS accepted `ACTION_CLICK` on its keys and entered nothing;
  the feature turned itself off after the one try, with no wrong attempt
  counted. Keys are now taps at their centre, once all of the PIN's keys
  have kept their bounds for 400 ms.
- Result on the phone (2026-10-13 14:45–14:46): screen on, keypad up, the
  PIN tapped by the app alone, unlocked, FID searched to its results, the
  phone locked again.
