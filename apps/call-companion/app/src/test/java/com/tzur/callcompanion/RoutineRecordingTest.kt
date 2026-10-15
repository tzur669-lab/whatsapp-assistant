package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Kind
import com.tzur.callcompanion.RoutineLogic.Node
import com.tzur.callcompanion.RoutineLogic.Routine
import com.tzur.callcompanion.RoutineLogic.Step
import com.tzur.callcompanion.RoutineRecording.Result
import com.tzur.callcompanion.ScreenLogic.Action
import com.tzur.callcompanion.ScreenLogic.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineRecordingTest {
    private val pkg = "com.example.fid"

    private fun button(path: String, text: String? = null, desc: String? = null, id: String? = null, target: Int) =
        Node(text, desc, id, true, true, target, clickable = true, className = "android.widget.Button", path = path, windowId = 1)

    private fun label(path: String, text: String, target: Int) =
        Node(text, null, null, true, true, target, className = "android.widget.TextView", path = path, windowId = 1)

    private fun field(path: String, hint: String?, target: Int, focused: Boolean = false, password: Boolean = false, id: String? = null) =
        Node(
            null, null, id, true, true, target, hint = hint, editable = true, clickable = true, focused = focused,
            password = password, className = "android.widget.EditText", path = path, windowId = 1,
        )

    private val tap = Action("tap", b = "x")
    private fun type(input: Int = 1) = Action("type", b = "x", input = input)
    private val submit = Action("submit", b = "x")
    private fun wait(s: Int) = Action("wait", seconds = s)

    private fun recorder(vararg inputs: String) = RoutineRecording(pkg, inputs.toList())

    private fun RoutineRecording.ok(action: Action, nodes: List<Node>?, index: Int, typedMatched: Boolean = true, held: Boolean = false) =
        record(action, nodes, index, Status.DISPATCHED, typedMatched, held)

    private fun draft(r: RoutineRecording): Result.Draft {
        val result = r.finish("completed_unverified")
        assertTrue("expected a draft, got $result", result is Result.Draft)
        return result as Result.Draft
    }

    private fun spoiled(r: RoutineRecording): String {
        val result = r.finish("completed_unverified")
        assertTrue("expected spoiled, got $result", result is Result.Spoiled)
        return (result as Result.Spoiled).reason
    }

    // --- the selector, in candidate order ---

    @Test fun aTapUsesTheNodesOwnTextFirst() {
        val nodes = listOf(button("0", text = "חיפוש", desc = "search", id = "com.example.fid:id/go", target = 0))
        val r = recorder().apply { ok(tap, nodes, 0) }
        assertEquals(listOf(Step(Kind.TAP_TEXT, "חיפוש")), draft(r).steps)
    }

    @Test fun aTwinTextFallsToTheDescription() {
        val nodes = listOf(
            button("0", text = "שמור", desc = "save draft", target = 0),
            button("1", text = "שמור", target = 1),
        )
        val r = recorder().apply { ok(tap, nodes, 0) }
        assertEquals(listOf(Step(Kind.TAP_TEXT, "save draft")), draft(r).steps)
    }

    @Test fun thenOneChildsOwnTextNeverTheJoinedLabel() {
        val nodes = listOf(
            button("0", text = "שמור", desc = "x", target = 0),
            button("1", text = "שמור", desc = "x", target = 1),
            label("0.0", "טיוטה", target = 0),
            label("0.1", "חדשה", target = 0),
        )
        val r = recorder().apply { ok(tap, nodes, 0) }
        assertEquals(listOf(Step(Kind.TAP_TEXT, "טיוטה")), draft(r).steps)
    }

    @Test fun aTwinLabelFallsToTheViewId() {
        val nodes = listOf(
            button("0", text = "שמור", id = "com.example.fid:id/save_a", target = 0),
            button("1", text = "שמור", id = "com.example.fid:id/save_b", target = 1),
        )
        val r = recorder().apply { ok(tap, nodes, 1) }
        assertEquals(listOf(Step(Kind.TAP_ID, "com.example.fid:id/save_b")), draft(r).steps)
    }

    @Test fun aNodeNamedOnlyByALenderIsRefused() {
        // The label sits on a plain container above the clickable (Compose): target < 0.
        val nodes = listOf(
            Node("כניסה", null, null, true, true, -1, className = "android.view.View", path = "0", windowId = 1),
            button("0.0", target = 1),
        )
        val r = recorder().apply { ok(tap, nodes, 1) }
        assertEquals("no_selector", spoiled(r))
    }

    @Test fun aTwinWithNothingElseIsRefused() {
        val nodes = listOf(button("0", text = "שמור", target = 0), button("1", text = "שמור", target = 1))
        val r = recorder().apply { ok(tap, nodes, 0) }
        assertEquals("no_selector", spoiled(r))
    }

    // --- typing and the field anchor ---

    @Test fun typeAfterATapOnTheSameFieldUsesTheAnchor() {
        val nodes = listOf(field("0", "חיפוש", target = 0, focused = true), button("1", text = "אישור", target = 1))
        val r = recorder(" סטימצקי ").apply {
            ok(tap, nodes, 0)
            ok(type(), nodes, 0)
        }
        assertEquals(listOf(Step(Kind.TAP_TEXT, "חיפוש"), Step(Kind.TYPE_TEXT, "סטימצקי")), draft(r).steps)
    }

    @Test fun typeWithNoAnchorAndOneFieldIsTodaysRule() {
        val nodes = listOf(field("0", "חיפוש", target = 0), button("1", text = "אישור", target = 1))
        val r = recorder("סטימצקי").apply { ok(type(), nodes, 0) }
        assertEquals(listOf(Step(Kind.TYPE_TEXT, "סטימצקי")), draft(r).steps)
    }

    @Test fun typeIntoOneOfTwoFieldsInsertsATapOnIt() {
        val nodes = listOf(field("0", "שם", target = 0), field("1", "עיר", target = 1))
        val r = recorder("חיפה").apply { ok(type(), nodes, 1) }
        assertEquals(listOf(Step(Kind.TAP_TEXT, "עיר"), Step(Kind.TYPE_TEXT, "חיפה")), draft(r).steps)
    }

    @Test fun anAnchorOnFieldAThenTypingIntoBInsertsATapOnB() {
        val nodes = listOf(field("0", "שם", target = 0), field("1", "עיר", target = 1))
        val r = recorder("חיפה").apply {
            ok(tap, nodes, 0)
            ok(type(), nodes, 1)
            ok(submit, nodes, 1)
        }
        assertEquals(
            listOf(Step(Kind.TAP_TEXT, "שם"), Step(Kind.TAP_TEXT, "עיר"), Step(Kind.TYPE_TEXT, "חיפה"), Step(Kind.SUBMIT)),
            draft(r).steps,
        )
    }

    @Test fun anAnchorOnFieldAThenSubmitIntoBIsRefused() {
        val nodes = listOf(field("0", "שם", target = 0), field("1", "עיר", target = 1, focused = true))
        val r = recorder().apply {
            ok(tap, nodes, 0)
            ok(submit, nodes, 1)
        }
        assertEquals("not_field", spoiled(r))
    }

    @Test fun aTapOnAButtonClearsTheAnchor() {
        val nodes = listOf(field("0", "שם", target = 0), field("1", "עיר", target = 1), button("2", text = "הבא", target = 2))
        val r = recorder("חיפה").apply {
            ok(tap, nodes, 0)
            ok(tap, nodes, 2)
            ok(type(), nodes, 0)
        }
        assertEquals(
            listOf(Step(Kind.TAP_TEXT, "שם"), Step(Kind.TAP_TEXT, "הבא"), Step(Kind.TAP_TEXT, "שם"), Step(Kind.TYPE_TEXT, "חיפה")),
            draft(r).steps,
        )
    }

    @Test fun aReadBackMismatchSpoils() {
        val nodes = listOf(field("0", "חיפוש", target = 0))
        val r = recorder("סטימצקי").apply { ok(type(), nodes, 0, typedMatched = false) }
        assertEquals("typed_differs", spoiled(r))
    }

    @Test fun typingIntoAPasswordFieldIsRefused() {
        val nodes = listOf(field("0", "סיסמה", target = 0, password = true))
        val r = recorder("1234").apply { ok(type(), nodes, 0) }
        assertEquals("password", spoiled(r))
    }

    @Test fun aSubmitWithNoAnchorNeedsTheFocusedField() {
        val unfocused = listOf(field("0", "חיפוש", target = 0))
        assertEquals("not_field", spoiled(recorder().apply { ok(submit, unfocused, 0) }))

        val focused = listOf(field("0", "חיפוש", target = 0, focused = true))
        val r = recorder("x").apply {
            ok(type(), focused, 0)
            ok(submit, focused, 0)
        }
        assertEquals(listOf(Step(Kind.TYPE_TEXT, "x"), Step(Kind.SUBMIT)), draft(r).steps)
    }

    // --- what spoils ---

    @Test fun scrollAndBackSpoil() {
        val nodes = listOf(button("0", text = "הבא", target = 0))
        assertEquals("scrolled", spoiled(recorder().apply { ok(tap, nodes, 0); ok(Action("scroll", b = "x", dir = "fwd"), nodes, 0) }))
        assertEquals("went_back", spoiled(recorder().apply { ok(tap, nodes, 0); ok(Action("back"), null, -1) }))
    }

    @Test fun anActionAndroidDidNotAcceptSpoils() {
        val nodes = listOf(button("0", text = "הבא", target = 0))
        val r = recorder().apply {
            ok(tap, nodes, 0)
            record(tap, nodes, 0, Status.NOT_ACCEPTED, typedMatched = true, held = false)
            ok(tap, nodes, 0)
        }
        assertEquals("not_accepted", spoiled(r))
    }

    @Test fun elevenStepsSpoil() {
        val nodes = listOf(button("0", text = "הבא", target = 0))
        val ten = recorder().apply { repeat(10) { ok(tap, nodes, 0) } }
        assertEquals(10, draft(ten).steps.size)
        val eleven = recorder().apply { repeat(11) { ok(tap, nodes, 0) } }
        assertEquals("too_long", spoiled(eleven))
    }

    @Test fun waitsAloneSpoilAndAreCapped() {
        assertEquals("no_action", spoiled(recorder().apply { ok(wait(3), null, -1) }))
        assertEquals("no_action", spoiled(recorder()))

        val nodes = listOf(button("0", text = "הבא", target = 0))
        val r = recorder().apply { ok(wait(30), null, -1); ok(tap, nodes, 0) }
        assertEquals(listOf(Step(Kind.WAIT, seconds = RoutineLogic.MAX_PAUSE_SECONDS), Step(Kind.TAP_TEXT, "הבא")), draft(r).steps)
    }

    @Test fun aSpoilFromOutsideKeepsTheFirstReason() {
        val nodes = listOf(button("0", text = "הבא", target = 0))
        val r = recorder().apply {
            spoil("replayed")
            ok(Action("back"), null, -1)
            ok(tap, nodes, 0)
        }
        assertEquals("replayed", spoiled(r))
    }

    @Test fun onlyACleanFinishGivesAnything() {
        val nodes = listOf(button("0", text = "הבא", target = 0))
        for (outcome in listOf("inconclusive", "asked", "uncertain", "stopped_user", "deadline", "error")) {
            val good = recorder().apply { ok(tap, nodes, 0) }
            assertEquals(outcome, Result.None, good.finish(outcome))
            val bad = recorder().apply { ok(Action("back"), null, -1) }
            assertEquals(outcome, Result.None, bad.finish(outcome))
        }
    }

    @Test fun anApprovedActionIsMarked() {
        val nodes = listOf(field("0", "שם", target = 0), field("1", "עיר", target = 1), button("2", text = "שלח", target = 2))
        val r = recorder("חיפה").apply {
            ok(type(), nodes, 1)
            ok(tap, nodes, 2, held = true)
        }
        val d = draft(r)
        assertEquals(3, d.steps.size)
        assertEquals(setOf(2), d.marked)
    }

    // --- the draft as a routine ---

    @Test fun aDraftOnceNamedIsAValidRoutineWithAStableHash() {
        val nodes = listOf(field("0", "חיפוש", target = 0, focused = true), button("1", text = "חפש", target = 1))
        fun record() = recorder("סטימצקי").apply {
            ok(tap, nodes, 0)
            ok(wait(2), null, -1)
            ok(type(), nodes, 0)
            ok(submit, nodes, 0)
        }
        val a = draft(record())
        val b = draft(record())
        val routine = Routine("r1", "חיפוש בפיד", pkg, "FID", a.steps)
        assertNull(RoutineLogic.problem(routine))
        assertEquals("name", RoutineLogic.problem(routine.copy(name = "")))
        assertEquals(RoutineLogic.stepHash(routine), RoutineLogic.stepHash(routine.copy(id = "r2", steps = b.steps)))
        assertTrue(a.steps.filter { it.kind == Kind.TAP_TEXT }.all { it.seconds == RoutineLogic.DEFAULT_SECONDS })
    }

    // -- part 2: every spoil reason has its own sentence --

    private fun source(name: String): String = generateSequence(java.io.File("").absoluteFile) { it.parentFile }
        .take(6)
        .map { java.io.File(it, "app/src/main/java/com/tzur/callcompanion/$name") }
        .plus(generateSequence(java.io.File("").absoluteFile) { it.parentFile }.take(6).map { java.io.File(it, "src/main/java/com/tzur/callcompanion/$name") })
        .first { it.isFile }
        .readText()

    @Test fun everySpoilReasonInTheCodeIsListed() {
        val recorder = source("RoutineRecording.kt").substringBefore("companion object")
        val actionKinds = setOf("tap", "type", "submit", "wait", "scroll", "back")
        val used = Regex(""""([a-z_]+)"""").findAll(recorder).map { it.groupValues[1] }.toSet() - actionKinds
        val fromRun = Regex("""recording\.spoil\("([a-z_]+)"\)""").findAll(source("ScreenRun.kt")).map { it.groupValues[1] }.toSet()
        assertTrue(fromRun.isNotEmpty())
        assertEquals(emptySet<String>(), (used + fromRun) - RoutineRecording.SPOIL_REASONS)
    }

    @Test fun everySpoilReasonHasItsOwnSentence() {
        val texts = RoutineRecording.SPOIL_REASONS.map { RoutineRecording.spoiledText(it) }
        assertEquals(RoutineRecording.SPOIL_REASONS.size, texts.toSet().size)
        assertEquals(R.string.draft_spoiled_error, RoutineRecording.spoiledText("unknown_code"))
    }
}
