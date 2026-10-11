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
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.WAIT_FOR_TEXT, "x", 21), Step(Kind.TAP_TEXT, "x")))))
        assertEquals("step", RoutineLogic.problem(clockIn.copy(steps = listOf(Step(Kind.TAP_ID, "../etc")))))
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
        assertEquals(Pick.None, RoutineLogic.pickTarget(listOf(node("כניסה", target = 0, enabled = false)), Step(Kind.TAP_TEXT, "כניסה")))
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

    // --- Outcomes ---

    @Test fun aFailureAfterATapIsNotCalledSafe() {
        assertEquals(Outcome.FAILED_BEFORE_TAP, RoutineLogic.failure(0, 1, "target_not_found").outcome)
        assertEquals(Outcome.FAILED_AFTER_TAP, RoutineLogic.failure(1, 2, "not_verified").outcome)
    }
}
