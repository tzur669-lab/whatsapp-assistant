# Routines — typing (app 0.13.0 → 0.13.1)

Decision (the user, 2026-10-11): a routine may type text, and the text is **fixed in the
user-built routine** — never from the model or the message. Target case: FID
(`cubbbixapps.fid` 139): EditText `display_message` (hint, clickable, editable), search
ImageButton `button_search` (no text, no description). Routine: `TYPE_TEXT "סטימצקי"` →
`TAP_ID button_search` → a check on the results (never the typed word itself, see 4).

## Changes

1. **`RoutineLogic.Kind`** gets `TYPE_TEXT` (value = text to type, ≤60, non-empty after
   `normalize`) and `SUBMIT` (value must be empty; the keyboard's Enter/search,
   `ACTION_IME_ENTER`). New `Step.isAction` = `isTap || TYPE_TEXT || SUBMIT`; `problem()`:
   `no_tap` → needs ≥1 action; `expect_order` uses the last action.
2. **Hash.** `stepHash` keeps its scheme for every existing kind (pinned by a literal hex
   captured at HEAD before any edit). For `TYPE_TEXT` only, the line carries the **raw
   trimmed** value, not `normalize`d — a change in case, spacing or invisible characters is
   a different text typed, so it is a different hash and an earlier confirmed run closes
   as `changed`.
3. **`RoutineLogic.pickField(nodes, needFocus)`** (pure): candidates = visible, editable,
   not password. The focused one if exactly one is focused; else (only when `needFocus` is
   false) the single candidate. None → `None`; several → `Many`; chosen one disabled →
   `Disabled`. `Node` gets `focused` and `password`. Several fields: tap the field by its
   hint first (`pickTarget` matches hints), which focuses it.
4. **Checks never count a field.** `hasText` and `isDisabled` skip `editable` nodes, and
   `pickTarget`'s TAP_TEXT matches an editable node by its hint only, not its content —
   otherwise `EXPECT_TEXT "סטימצקי"` would pass on the typed word (false VERIFIED), and a
   suggestion with the same words would be ambiguous. Existing routines are unaffected
   (their checks are on buttons/labels).
5. **Service.** `TYPE_TEXT`: `waitUntilStable`, snapshot, `pickField(needFocus=false)`; a
   dry run stops here (`DRY_RUN_OK`); else the click guard (unlocked, `refresh`, same
   package, visible, enabled, editable, not password, active window is the routine's) →
   `ACTION_FOCUS` if not focused → `ACTION_SET_TEXT`. `tapped++` **as soon as
   `performAction` returns true**, then `lastChangeAt = now`, then re-read and compare
   (`normalize`) → mismatch is `tap_refused` (FAILED_AFTER_TAP). `SUBMIT`:
   `pickField(needFocus=true)` → same guard → `ACTION_IME_ENTER`, `tapped++`,
   `lastChangeAt = now`. The keyboard may cover a later target: the FID routine taps the
   search button, which sits above the keyboard; a `WAIT` step is the remedy elsewhere.
   Reason codes reused (`target_not_found`, `target_ambiguous`, `target_disabled`,
   `tap_refused`): `RUN_REASONS` / the app's `REASONS` stay as they are.
6. **API < 30**: `SUBMIT` is not offered in the step picker, and a stored one fails as
   `tap_refused` (there is no such phone today; the user's phone is API 34).
7. **Wording.** Server `src/render/routines.ts`: `target_not_found` / `target_ambiguous` /
   `tap_refused` / `unknown` / `unverified` texts become action-neutral ("הפעולה",
   "השלבים") — text only, codes unchanged, its tests updated. App strings likewise
   (`routine_reason_*`, `routine_result_*`, `routine_problem_no_tap`, `routines_intro`
   line 182–184 "לא מקלידה כלום", `routine_service_description`). Hebrew via the hebrew
   skills.
8. **Downgrade (accepted risk).** An older APK drops a routine with a new kind
   (`RoutineStore.read`) and the next write forgets it. Single user, no downgrade path in
   use; written down in PLAN §6.27.
9. **Docs/comments:** `RoutineLogic.kt` header, service KDoc, accessibility XML comment,
   `apps/call-companion/README.md` (step list, "No typing"), PLAN §6.27 + §14 line,
   HANDOFF version line + session log, ARCHITECTURE if it lists step kinds, a pointer note
   in `docs/plans/routines.md`. `versionName` 0.13.1 / `versionCode` 18.
10. **Tests first** (`RoutineLogicTest`): validation (SUBMIT with a value refused),
    typing-only routine valid, `expect_order` after typing, `pickField` cases, hash literal
    for an existing routine, TYPE_TEXT hash differs by case, `hasText` ignores a field.
11. **Verify on the real phone** (adb): install, build the FID routine, dry run, real run.
    A scheduled "בעוד רבע שעה" needs the staging deploy (approval) — reported as owed.

Out of scope: the bot building routines from a request (separate plan).

## Rejected objections

None.
