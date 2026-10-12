package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Kind
import com.tzur.callcompanion.RoutineLogic.Node
import com.tzur.callcompanion.RoutineLogic.Outcome
import com.tzur.callcompanion.RoutineLogic.Pick
import com.tzur.callcompanion.RoutineLogic.Routine
import com.tzur.callcompanion.RoutineLogic.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineLogicTest {
    private val clockIn = Routine(
        id = "r1",
        name = "כניסה לעבודה",
        packageName = "com.example.clock",
        appLabel = "Clock",
        steps = listOf(
            Step(Kind.WAIT_FOR_TEXT, "דיווח נוכחות", 15),
            Step(Kind.TAP_TEXT, "כניסה"),
            Step(Kind.EXPECT_TEXT, "הדיווח נקלט", 15),
        ),
    )

    private fun node(text: String? = null, desc: String? = null, id: String? = null, target: Int, visible: Boolean = true, enabled: Boolean = true) =
        Node(text, desc, id, visible, enabled, target)

    private fun field(text: String? = null, hint: String? = null, target: Int, focused: Boolean = false, password: Boolean = false, enabled: Boolean = true, visible: Boolean = true) =
        Node(text, null, null, visible, enabled, target, hint = hint, editable = true, clickable = true, focused = focused, password = password)

    // --- Validation ---

    @Test fun aGoodRoutineHasNoProblem() {
        assertNull(RoutineLogic.problem(clockIn))
        assertTrue(clockIn.verifies)
    }

    @Test fun aRoutineMustTap() {
        assertEquals("no_tap", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.WAIT, seconds = 2)))))
    }

    @Test fun limitsAreEnforced() {
        assertEquals("name", RoutineLogic.problem(clockIn.copy(name = " ")))
        assertEquals("name", RoutineLogic.problem(clockIn.copy(name = "א".repeat(41))))
        assertEquals("app", RoutineLogic.problem(clockIn.copy(packageName = "not a package")))
        assertEquals("steps", RoutineLogic.problem(clockIn.copy(steps = List(11) { Step(Kind.TAP_TEXT, "x") })))
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.TAP_TEXT, "")))))
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.TAP_TEXT, "x"), Step(Kind.WAIT, seconds = 6)))))
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.WAIT_FOR_TEXT, "x", 61), Step(Kind.TAP_TEXT, "x")))))
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.TAP_ID, "../etc")))))
    }

    @Test fun screenWordsAreNotAViewId() {
        assertEquals("id", RoutineLogic.stepProblem(Step(Kind.TAP_ID, "אולפנה רבבה-2711")))
        assertNull(RoutineLogic.stepProblem(Step(Kind.TAP_TEXT, "אולפנה רבבה-2711")))
        assertNull(RoutineLogic.stepProblem(Step(Kind.TAP_ID, "clock_in")))
        assertEquals("text", RoutineLogic.stepProblem(Step(Kind.TAP_TEXT, " ")))
        assertEquals("seconds", RoutineLogic.stepProblem(Step(Kind.WAIT, seconds = 9)))
    }

    @Test fun theCheckComesAfterEveryTap() {
        val wrong = clockIn.copy(steps = listOf(Step(Kind.TAP_TEXT, "כניסה"), Step(Kind.EXPECT_TEXT, "נקלט"), Step(Kind.TAP_TEXT, "אישור")))
        assertEquals("expect_order", RoutineLogic.problem(wrong))
    }

    // --- Hash ---

    @Test fun theHashFollowsTheStepsNotTheName() {
        val hash = RoutineLogic.stepHash(clockIn)
        assertEquals(64, hash.length)
        assertEquals(hash, RoutineLogic.stepHash(clockIn.copy(name = "שם אחר")))
        assertNotEquals(hash, RoutineLogic.stepHash(clockIn.copy(steps = clockIn.steps.dropLast(1))))
        assertNotEquals(hash, RoutineLogic.stepHash(clockIn.copy(packageName = "com.example.other")))
    }

    @Test fun anExistingRoutineKeepsItsHash() {
        // Captured at HEAD before typing existed (0.13.0): a run confirmed then still matches.
        assertEquals("97d02a79bf90006991aaa99c8ac1cee5ce99966abb29d8074e740aeacaf00a93", RoutineLogic.stepHash(clockIn))
    }

    @Test fun theTypedTextIsHashedAsWritten() {
        val a = clockIn.copy(steps = listOf(Step(Kind.TYPE_TEXT, "Steimatzky"), Step(Kind.TAP_ID, "button_search")))
        val b = clockIn.copy(steps = listOf(Step(Kind.TYPE_TEXT, "steimatzky"), Step(Kind.TAP_ID, "button_search")))
        assertNotEquals(RoutineLogic.stepHash(a), RoutineLogic.stepHash(b))
    }

    // --- Typing ---

    private val fidSearch = Routine("f", "חיפוש סטימצקי", "cubbbixapps.fid", "FID", listOf(
        Step(Kind.TYPE_TEXT, "סטימצקי"),
        Step(Kind.TAP_ID, "button_search"),
    ))

    @Test fun aTypingRoutineIsValid() {
        assertNull(RoutineLogic.problem(fidSearch))
        assertNull(RoutineLogic.problem(fidSearch.copy(steps = listOf(Step(Kind.TYPE_TEXT, "x"), Step(Kind.SUBMIT)))))
        assertNull(RoutineLogic.problem(fidSearch.copy(steps = listOf(Step(Kind.TYPE_TEXT, "x")))))
    }

    @Test fun typingStepsAreChecked() {
        assertEquals("text", RoutineLogic.stepProblem(Step(Kind.TYPE_TEXT, " ")))
        assertEquals("text", RoutineLogic.stepProblem(Step(Kind.TYPE_TEXT, "א".repeat(61))))
        assertEquals("text", RoutineLogic.stepProblem(Step(Kind.SUBMIT, "x")))
        assertNull(RoutineLogic.stepProblem(Step(Kind.SUBMIT)))
    }

    @Test fun theCheckComesAfterTheTyping() {
        val wrong = fidSearch.copy(steps = listOf(Step(Kind.EXPECT_TEXT, "תוצאות"), Step(Kind.TYPE_TEXT, "x")))
        assertEquals("expect_order", RoutineLogic.problem(wrong))
    }

    @Test fun theFocusedFieldIsTheOneTypedInto() {
        val nodes = listOf(field(hint = "שם", target = 0), field(hint = "עיר", target = 1, focused = true))
        assertEquals(Pick.One(1), RoutineLogic.pickField(nodes, needFocus = false))
        assertEquals(Pick.One(1), RoutineLogic.pickField(nodes, needFocus = true))
    }

    @Test fun aSingleFieldNeedsNoFocusToType() {
        val nodes = listOf(node("חיפוש", target = 0), field(hint = "מה מחפשים", target = 1))
        assertEquals(Pick.One(1), RoutineLogic.pickField(nodes, needFocus = false))
        assertEquals(Pick.None, RoutineLogic.pickField(nodes, needFocus = true))
    }

    @Test fun twoUnfocusedFieldsTypeNothing() {
        val nodes = listOf(field(target = 0), field(target = 1))
        assertEquals(Pick.Many(2), RoutineLogic.pickField(nodes, needFocus = false))
    }

    @Test fun aPasswordFieldIsNeverTypedInto() {
        assertEquals(Pick.None, RoutineLogic.pickField(listOf(field(target = 0, focused = true, password = true)), needFocus = false))
        assertEquals(Pick.One(1), RoutineLogic.pickField(listOf(field(target = 0, password = true), field(target = 1)), needFocus = false))
    }

    @Test fun aHiddenOrDisabledFieldIsNotTypedInto() {
        assertEquals(Pick.None, RoutineLogic.pickField(listOf(field(target = 0, visible = false)), needFocus = false))
        assertEquals(Pick.Disabled, RoutineLogic.pickField(listOf(field(target = 0, enabled = false)), needFocus = false))
    }

    @Test fun aCheckNeverCountsTheTypedText() {
        val nodes = listOf(field("סטימצקי", target = 0, focused = true))
        assertFalse(RoutineLogic.hasText(nodes, "סטימצקי"))
        assertFalse(RoutineLogic.isDisabled(listOf(field("סטימצקי", target = 0, enabled = false)), "סטימצקי"))
    }

    @Test fun aFieldIsTappedByItsHintNotItsContent() {
        val nodes = listOf(field("סטימצקי", hint = "מה מחפשים", target = 0), node("סטימצקי", target = 1))
        assertEquals(Pick.One(1), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "סטימצקי")))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "מה מחפשים")))
    }

    // --- Matching ---

    @Test fun matchingIsWholeTextNotContains() {
        val nodes = listOf(node("כניסה מאוחרת", target = 0), node("יציאה", target = 1))
        assertEquals(Pick.None, RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun bidiMarksSpacesAndCaseDoNotMatter() {
        val nodes = listOf(node("⁨ Clock  In ⁩", target = 0))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "clock in")))
    }

    @Test fun aLabelInsideAClickableButtonTapsTheButton() {
        // 0: the button (clickable), 1: its label (not clickable) → target 0.
        val nodes = listOf(node(target = 0), node("כניסה", target = 0))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun twoPlacesWithTheSameTextTapNothing() {
        val nodes = listOf(node("כניסה", target = 0), node("כניסה", target = 1))
        assertEquals(Pick.Many(2), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun hiddenOrDisabledTargetsAreNotTapped() {
        assertEquals(Pick.None, RoutineLogic.pickTarget(listOf(node("כניסה", target = 0, visible = false)), Step(Kind.TAP_TEXT, "כניסה")))
        assertEquals(Pick.Disabled, RoutineLogic.pickTarget(listOf(node("כניסה", target = 0, enabled = false)), Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun aTextWithNothingClickableAroundItIsNotTapped() {
        assertEquals(Pick.None, RoutineLogic.pickTarget(listOf(node("כניסה", target = -1)), Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun theDescriptionCountsLikeText() {
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(listOf(node(desc = "כניסה", target = 0)), Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun viewIdsMatchShortOrWhole() {
        val nodes = listOf(node(id = "com.example.clock:id/clock_in", target = 0), node(id = "com.example.clock:id/clock_out", target = 1))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_ID, "clock_in")))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(nodes, Step(Kind.TAP_ID, "com.example.clock:id/clock_in")))
        assertEquals(Pick.None, RoutineLogic.pickTarget(nodes, Step(Kind.TAP_ID, "other:id/clock_in")))
    }

    @Test fun hasTextSeesOnlyVisibleWholeText() {
        val nodes = listOf(node("הדיווח נקלט", target = -1), node("סוד", target = -1, visible = false))
        assertTrue(RoutineLogic.hasText(nodes, "הדיווח נקלט"))
        assertFalse(RoutineLogic.hasText(nodes, "נקלט"))
        assertFalse(RoutineLogic.hasText(nodes, "סוד"))
    }

    // --- The attendance app's real shape (read with uiautomator, 2026-10-11) ---

    /** btn_logout (יציאה, on), btn_login (כניסה, off after the punch); both labels are tv_logout. */
    private fun attendance(loginEnabled: Boolean) = listOf(
        node(id = "com.ok2go.ok2go:id/btn_logout", target = 0),
        node("יציאה", id = "com.ok2go.ok2go:id/tv_logout", target = 0),
        node(id = "com.ok2go.ok2go:id/btn_login", target = 2, enabled = loginEnabled),
        node("כניסה", id = "com.ok2go.ok2go:id/tv_logout", target = 2),
    )

    @Test fun clockInIsTappedThroughItsLabel() {
        assertEquals(Pick.One(2), RoutineLogic.pickTarget(attendance(true), Step(Kind.TAP_TEXT, "כניסה")))
        assertEquals(Pick.One(2), RoutineLogic.pickTarget(attendance(true), Step(Kind.TAP_ID, "btn_login")))
    }

    @Test fun clockInAfterThePunchIsDisabledNotMissing() {
        assertEquals(Pick.Disabled, RoutineLogic.pickTarget(attendance(false), Step(Kind.TAP_TEXT, "כניסה")))
    }

    @Test fun theSharedLabelIdIsAmbiguous() {
        assertEquals(Pick.Many(2), RoutineLogic.pickTarget(attendance(true), Step(Kind.TAP_ID, "tv_logout")))
    }

    @Test fun thePunchIsProvedByTheButtonGoingOff() {
        assertFalse(RoutineLogic.isDisabled(attendance(true), "כניסה"))
        assertTrue(RoutineLogic.isDisabled(attendance(false), "כניסה"))
        // "יציאה" is on the screen either way: a text check would prove nothing.
        assertTrue(RoutineLogic.hasText(attendance(true), "יציאה"))
        assertFalse(RoutineLogic.isDisabled(attendance(false), "חסר"))
    }

    @Test fun aDisabledCheckCountsAsVerification() {
        val r = Routine("r", "כניסה", "com.ok2go.ok2go", "clock2go2020",
            listOf(Step(Kind.TAP_TEXT, "כניסה"), Step(Kind.EXPECT_DISABLED, "כניסה", 15)))
        assertNull(RoutineLogic.problem(r))
        assertTrue(r.verifies)
    }

    @Test fun thePhonesLaunchQuestionIsRecognised() {
        assertTrue(RoutineLogic.isLaunchConfirm("com.oplus.securitypermission"))
        assertFalse(RoutineLogic.isLaunchConfirm("com.ok2go.ok2go"))
        assertFalse(RoutineLogic.isLaunchConfirm(null))
    }

    // --- The field anchor (Improvement plan §3 T4) ---

    private val tapSearch = Step(Kind.TAP_TEXT, "חיפוש")
    private val typeText = Step(Kind.TYPE_TEXT, "סטימצקי")

    /** Runs the steps' anchor bookkeeping, as the runner will: [tappedEditable] per tap, in order. */
    private fun anchorThrough(steps: List<Step>, vararg tappedEditable: Boolean): Step? {
        var anchor: Step? = null
        var tap = 0
        for (step in steps) anchor = RoutineLogic.anchorAfter(anchor, step, step.isTap && tappedEditable[tap++])
        return anchor
    }

    @Test fun aTapOnAnEditableFieldBecomesTheAnchor() {
        assertEquals(tapSearch, anchorThrough(listOf(tapSearch), true))
        assertNull(anchorThrough(listOf(tapSearch), false))
    }

    @Test fun theAnchorSurvivesPausesTypingAndSubmit() {
        val steps = listOf(
            tapSearch,
            Step(Kind.WAIT, seconds = 2),
            Step(Kind.WAIT_FOR_TEXT, "תוצאות", 15),
            typeText,
            Step(Kind.SUBMIT),
        )
        assertEquals(tapSearch, anchorThrough(steps, true))
    }

    @Test fun aNonFieldTapClearsTheAnchor() {
        assertNull(anchorThrough(listOf(tapSearch, Step(Kind.TAP_TEXT, "המשך")), true, false))
    }

    @Test fun theAnchoredFieldStillFocusedIsTypedInto() {
        val nodes = listOf(node("כותרת", target = -1), field(hint = "חיפוש", target = 1, focused = true))
        assertEquals(Pick.One(1), RoutineLogic.anchoredField(nodes, tapSearch, needFocus = false))
    }

    @Test fun tapWaitTypeWithTheFocusMovedIsFieldChanged() {
        // TAP field → WAIT → TYPE: during the wait the app moved the cursor to another field.
        val anchor = anchorThrough(listOf(tapSearch, Step(Kind.WAIT, seconds = 2)), true)
        val nodes = listOf(field(hint = "חיפוש", target = 0), field(hint = "עיר", target = 1, focused = true))
        assertEquals(Pick.FieldChanged, RoutineLogic.anchoredField(nodes, anchor, needFocus = false))
        // Today's rule would have typed into the other, focused field.
        assertEquals(Pick.One(1), RoutineLogic.pickField(nodes, needFocus = false))
    }

    @Test fun tapWaitForTextTypeSubmitWithTheFocusKeptRuns() {
        val anchor = anchorThrough(listOf(tapSearch, Step(Kind.WAIT_FOR_TEXT, "תוצאות", 15), typeText), true)
        val nodes = listOf(node("תוצאות", target = -1), field(text = "סטימצקי", hint = "חיפוש", target = 1, focused = true))
        assertEquals(Pick.One(1), RoutineLogic.anchoredField(nodes, anchor, needFocus = false))
        assertEquals(Pick.One(1), RoutineLogic.anchoredField(nodes, anchor, needFocus = true))
    }

    @Test fun theAnchoredFieldGoneWhileAnotherIsFocusedIsFieldChanged() {
        // The app navigated: the tapped field is gone, a different one has the cursor.
        val nodes = listOf(node("מסך אחר", target = -1), field(hint = "הערה", target = 1, focused = true))
        assertEquals(Pick.FieldChanged, RoutineLogic.anchoredField(nodes, tapSearch, needFocus = false))
    }

    @Test fun aNonEditableLauncherLeavesTodaysRule() {
        // A "fake" search box: a clickable label, not a field. Its tap sets no anchor…
        val launcher = listOf(node("חיפוש", target = 0))
        assertEquals(Pick.One(0), RoutineLogic.pickTarget(launcher, tapSearch))
        val anchor = anchorThrough(listOf(tapSearch), launcher[0].editable)
        assertNull(anchor)
        // …so the new screen's one focused field is typed into, as today.
        val next = listOf(field(hint = "מה לחפש?", target = 0, focused = true))
        assertEquals(Pick.One(0), RoutineLogic.anchoredField(next, anchor, needFocus = false))
    }

    @Test fun typingWithNoTapKeepsTodaysRule() {
        // FID: TYPE_TEXT into the first screen's only field, with no tap before it.
        val anchor = anchorThrough(listOf(typeText, Step(Kind.TAP_ID, "button_search")), false)
        assertNull(anchor)
        val nodes = listOf(field(hint = "חיפוש", target = 0))
        assertEquals(Pick.One(0), RoutineLogic.anchoredField(nodes, null, needFocus = false))
    }

    @Test fun anAnchorPresentButUnfocusedIsFieldChanged() {
        val nodes = listOf(field(hint = "חיפוש", target = 0), field(hint = "עיר", target = 1))
        assertEquals(Pick.FieldChanged, RoutineLogic.anchoredField(nodes, tapSearch, needFocus = false))
    }

    @Test fun anAnchorMatchingTwoFieldsStops() {
        val nodes = listOf(field(hint = "חיפוש", target = 0, focused = true), field(hint = "חיפוש", target = 1))
        assertEquals(Pick.Many(2), RoutineLogic.anchoredField(nodes, tapSearch, needFocus = false))
    }

    @Test fun anAnchoredPasswordFieldIsNeverTypedInto() {
        val nodes = listOf(field(hint = "חיפוש", target = 0, focused = true, password = true))
        assertEquals(Pick.FieldChanged, RoutineLogic.anchoredField(nodes, tapSearch, needFocus = false))
    }

    // --- Outcomes ---

    @Test fun aFailureAfterATapIsNotCalledSafe() {
        assertEquals(Outcome.FAILED_BEFORE_TAP, RoutineLogic.failure(0, 1, "target_not_found").outcome)
        assertEquals(Outcome.FAILED_AFTER_TAP, RoutineLogic.failure(1, 2, "not_verified").outcome)
    }
}
