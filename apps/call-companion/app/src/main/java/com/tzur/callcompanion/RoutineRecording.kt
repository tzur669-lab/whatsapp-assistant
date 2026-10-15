package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Kind
import com.tzur.callcompanion.RoutineLogic.Node
import com.tzur.callcompanion.RoutineLogic.Pick
import com.tzur.callcompanion.RoutineLogic.Step
import com.tzur.callcompanion.ScreenLogic.Status

/**
 * Screen agent phase 3 (plan `docs/plans/routine-from-screen-task.md`): turns
 * the actions a confirmed screen task actually ran into routine steps. One per
 * [ScreenRun], fed after each action's journal outcome. The model only picked
 * elements by index; code picks the selector and the text here. Nothing is
 * stored: the draft lives in memory ([RoutineDrafts]) until the user saves it.
 *
 * Every selector is proved on the snapshot the action used, through the
 * runner's own [RoutineLogic.pickTarget] / [RoutineLogic.pickField], so on that
 * screen the step acts on that node and nothing else.
 */
class RoutineRecording(private val packageName: String, private val inputs: List<String>) {

    sealed class Result {
        /** [marked]: indexes of steps the user approved during the task. */
        data class Draft(val steps: List<Step>, val marked: Set<Int>) : Result()
        /** A clean finish that cannot become a routine: a reason code only, no steps. */
        data class Spoiled(val reason: String) : Result()
        /** Not a clean finish: nothing is offered. */
        object None : Result()
    }

    private val steps = ArrayList<Step>()
    private val marked = HashSet<Int>()
    /** The binding of the last recorded tap on an editable field (the runner's field anchor). */
    private var anchor: String? = null
    private var spoiled: String? = null

    /**
     * One action and its journal outcome. [nodes]/[index]: the snapshot the
     * action used and its node (null for `wait` and `back`). [typedMatched]:
     * a `type`'s read-back equalled the input. [held]: the user approved it.
     */
    fun record(
        action: ScreenLogic.Action,
        nodes: List<Node>?,
        index: Int,
        outcome: Status,
        typedMatched: Boolean,
        held: Boolean,
    ) {
        if (spoiled != null) return
        if (outcome != Status.DISPATCHED) return spoil("not_accepted")
        val before = steps.size
        val problem = when (action.kind) {
            "tap" -> tap(nodes, index)
            "type" -> type(action, nodes, index, typedMatched)
            "submit" -> submit(nodes, index)
            "wait" -> {
                steps.add(Step(Kind.WAIT, seconds = action.seconds.coerceIn(1, RoutineLogic.MAX_PAUSE_SECONDS)))
                null
            }
            "scroll" -> "scrolled"
            "back" -> "went_back"
            else -> "error"
        }
        if (problem != null) return spoil(problem)
        if (steps.size > RoutineLogic.MAX_STEPS) return spoil("too_long")
        if (held) for (i in before until steps.size) if (steps[i].isAction) marked.add(i)
    }

    /** Spoils the recording from outside (an action replayed from the journal, not run here). */
    fun spoil(reason: String) {
        if (spoiled == null) spoiled = reason
    }

    /** At the server's `end`: only `completed_unverified` with an unspoiled recording yields a draft. */
    fun finish(outcome: String): Result {
        if (outcome != CLEAN_FINISH) return Result.None
        spoiled?.let { return Result.Spoiled(it) }
        if (steps.none { it.isAction }) return Result.Spoiled("no_action")
        return Result.Draft(steps.toList(), marked.toSet())
    }

    private fun tap(nodes: List<Node>?, index: Int): String? {
        val node = nodes?.getOrNull(index) ?: return "error"
        val step = selector(nodes, index) ?: return "no_selector"
        steps.add(step)
        anchor = if (node.editable) ScreenLogic.binding(node, packageName) else null
        return null
    }

    private fun type(action: ScreenLogic.Action, nodes: List<Node>?, index: Int, typedMatched: Boolean): String? {
        val node = nodes?.getOrNull(index) ?: return "error"
        if (!node.editable) return "error"
        if (node.password) return "password"
        if (!typedMatched) return "typed_differs"
        val text = inputs.getOrNull(action.input - 1)?.trim() ?: return "error"
        val typing = Step(Kind.TYPE_TEXT, text)
        if (RoutineLogic.stepProblem(typing) != null) return "text"
        val binding = ScreenLogic.binding(node, packageName)
        val inPlace = when (val current = anchor) {
            null -> RoutineLogic.pickField(nodes, needFocus = false) == Pick.One(index)
            else -> current == binding
        }
        if (!inPlace) {
            // At run time this tap becomes the anchor, so the typing goes only there.
            steps.add(selector(nodes, index) ?: return "no_selector")
            anchor = binding
        }
        steps.add(typing)
        return null
    }

    private fun submit(nodes: List<Node>?, index: Int): String? {
        val node = nodes?.getOrNull(index) ?: return "error"
        val same = when (val current = anchor) {
            null -> RoutineLogic.pickField(nodes, needFocus = true) == Pick.One(index)
            else -> current == ScreenLogic.binding(node, packageName)
        }
        if (!same) return "not_field"
        steps.add(Step(Kind.SUBMIT))
        return null
    }

    /**
     * The tap step that reaches exactly node [index] on this snapshot: its own
     * text (a field: its hint), its description, one child's own text, its
     * view id — the first that [RoutineLogic.pickTarget] maps to [index] alone.
     * Never the joined child label, never a lender's label. Null: none does.
     */
    private fun selector(nodes: List<Node>, index: Int): Step? {
        val node = nodes[index]
        val texts = ArrayList<String?>()
        texts.add(if (node.editable) node.hint else node.text.takeUnless { node.password })
        texts.add(node.description)
        nodes.forEachIndexed { j, child -> if (j != index && child.target == index && !child.editable) texts.add(child.text) }
        val candidates = texts.mapNotNull { it?.trim()?.ifEmpty { null } }.map { Step(Kind.TAP_TEXT, it) } +
            listOfNotNull(node.viewId?.trim()?.ifEmpty { null }?.let { Step(Kind.TAP_ID, it) })
        return candidates.firstOrNull { step ->
            RoutineLogic.stepProblem(step) == null && RoutineLogic.pickTarget(nodes, step) == Pick.One(index)
        }
    }

    companion object {
        /** The model's `done` (`src/agent/screen-step.ts`): the only end that offers a draft. */
        const val CLEAN_FINISH = "completed_unverified"

        /** Every [Result.Spoiled] reason; each has its own fixed sentence ([spoiledText]). */
        val SPOIL_REASONS = setOf(
            "not_accepted", "scrolled", "went_back", "error", "too_long", "no_selector",
            "password", "typed_differs", "text", "not_field", "no_action", "replayed",
        )

        /** The "can't be saved as a routine" sentence for [reason]; an unknown code reads as an error. */
        fun spoiledText(reason: String): Int = when (reason) {
            "not_accepted" -> R.string.draft_spoiled_not_accepted
            "scrolled" -> R.string.draft_spoiled_scrolled
            "went_back" -> R.string.draft_spoiled_went_back
            "too_long" -> R.string.draft_spoiled_too_long
            "no_selector" -> R.string.draft_spoiled_no_selector
            "password" -> R.string.draft_spoiled_password
            "typed_differs" -> R.string.draft_spoiled_typed_differs
            "text" -> R.string.draft_spoiled_text
            "not_field" -> R.string.draft_spoiled_not_field
            "no_action" -> R.string.draft_spoiled_no_action
            "replayed" -> R.string.draft_spoiled_replayed
            else -> R.string.draft_spoiled_error
        }
    }
}
