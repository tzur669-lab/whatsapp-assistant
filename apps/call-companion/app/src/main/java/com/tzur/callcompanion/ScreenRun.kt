package com.tzur.callcompanion

import android.content.Context
import android.os.SystemClock
import com.tzur.callcompanion.RoutineAccessibilityService.Found
import com.tzur.callcompanion.RoutineAccessibilityService.Target
import com.tzur.callcompanion.ScreenLogic.Answer
import com.tzur.callcompanion.ScreenLogic.Cls
import com.tzur.callcompanion.ScreenLogic.Event
import com.tzur.callcompanion.ScreenLogic.Report
import com.tzur.callcompanion.ScreenLogic.Status
import com.tzur.callcompanion.ScreenLogic.Why

/**
 * One claimed screen task's loop, on the service's worker thread
 * ([ScreenAgentRunner] claims, opens and cleans up around it). Spec C: each
 * step sends the screen and the previous action's report, and handles
 * `act | approval | released | wait | end | stopped`.
 *
 * Every way out sends at most one `/app/screen/result` ([end], [stopped]) —
 * or none, when the server ended the task itself ([quiet]).
 */
internal class ScreenRun(private val app: Context, private val task: ScreenAgentRunner.Task) {

    private lateinit var ops: RoutineAccessibilityService.ScreenOps
    private var step = 1
    /** Step N-1's action, owed to the server with step N (or with the result). */
    private var report: Report? = null
    private var typedNonSearch = false
    /** Actions the phone already held: a second hold for the same one is an error, not a loop. */
    private val holds = HashSet<String>()
    private var finished = false

    private sealed class Ex {
        class Got(val answer: Answer) : Ex()
        /** `stopped`, `deadline`, `unreachable` or `error`. */
        class Fail(val code: String) : Ex()
    }

    /** Where an action acts: its node (null for back and wait). */
    private class Located(val target: Target?)

    fun start(ops: RoutineAccessibilityService.ScreenOps) {
        this.ops = ops
        val problem = ops.open(task.deadline)
        if (task.stopped) return stopped(null)
        if (problem != null) return end(problem, null)
        loop()
    }

    private fun loop() {
        while (true) {
            if (task.stopped) return stopped(report)
            if (late()) return end("deadline", report)
            if (step > task.maxSteps) return end("step_limit", report)
            if (ScreenAllowStore.get(app, task.packageName) == null) return end("not_allowed", report)
            var nodes = ops.read(task.deadline)
                ?: return if (task.stopped) stopped(report) else end(ops.whyNotFront(), report)
            var elements = ScreenLogic.elements(nodes, task.packageName)
            // An app still loading reads as nothing labelled (found on the phone,
            // 2026-10-12: FID's splash ended the task `tree_unusable`). Read again
            // a few times before the server judges it.
            var rereads = 0
            while (!ScreenLogic.usable(elements) && rereads < UNUSABLE_REREADS) {
                pause(UNUSABLE_WAIT_MS)
                if (task.stopped) return stopped(report)
                if (late()) return end("deadline", report)
                rereads++
                nodes = ops.read(task.deadline)
                    ?: return if (task.stopped) stopped(report) else end(ops.whyNotFront(), report)
                elements = ScreenLogic.elements(nodes, task.packageName)
            }
            val body = Protocol.screenStepBody(task.taskId, step, ScreenLogic.screenHash(elements), elements, report)
            when (val ex = exchange(body)) {
                is Ex.Fail -> return failWith(ex.code, report)
                is Ex.Got -> {
                    // The server answered step N, so it has step N-1's report.
                    report = null
                    if (!handle(ex.answer)) return
                }
            }
        }
    }

    /**
     * One request, sent again unchanged on no answer (the server answers a
     * retry with the same stored action) and after a `wait`. A stop aborts
     * it, and an answer that arrives after a stop is ignored.
     */
    private fun exchange(body: String): Ex {
        var failures = 0
        while (true) {
            if (task.stopped) return Ex.Fail("stopped")
            if (late()) return Ex.Fail("deadline")
            val reply = Api.screenStep(app, body, task.newCall())
            if (task.stopped) return Ex.Fail("stopped")
            when (reply) {
                is Api.ScreenReply.Answer -> {
                    val answer = reply.answer
                    if (answer !is Answer.Wait) return Ex.Got(answer)
                    pause(ScreenLogic.retryDelayMs(answer.retryAfterMs))
                }
                Api.ScreenReply.Unreachable -> {
                    failures++
                    if (failures >= MAX_FAILURES) return Ex.Fail("unreachable")
                    pause(RETRY_MS * failures)
                }
                Api.ScreenReply.Refused -> return Ex.Fail("error")
            }
        }
    }

    /** True: go on with the next step. False: the task ended (already reported). */
    private fun handle(answer: Answer): Boolean = when (answer) {
        is Answer.End, is Answer.Stopped -> {
            quiet()
            false
        }
        is Answer.Wait -> true
        is Answer.Act ->
            if (answer.step != step) endFalse("error") else act(answer.actionId, answer.action, answer.cls)
        is Answer.Approval -> if (answer.step != step) endFalse("error") else approval(answer)
        is Answer.Released -> if (answer.step != step) endFalse("error") else released(answer)
    }

    // -- the three answers that carry an action ------------------------------------

    private fun act(actionId: String, action: ScreenLogic.Action, serverCls: Cls): Boolean {
        replayed(actionId, allowHeld = false)?.let { return it }
        if (!ScreenLogic.validAction(action, task.inputs.size)) return refuseAndEnd(actionId, "error")
        val located = locate(actionId, action) ?: return false
        val own = ownClass(action, located)
        if (own.first > serverCls) {
            // The higher class wins: held here, and the server asks the user (plan §3).
            ScreenJournal.move(app, task.taskId, actionId, Event.HOLD)
            return hold(actionId, own)
        }
        return dispatch(actionId, action, located.target)
    }

    private fun approval(answer: Answer.Approval): Boolean {
        val actionId = answer.actionId
        replayed(actionId, allowHeld = true)?.let { return it }
        if (!ScreenLogic.validAction(answer.action, task.inputs.size)) return refuseAndEnd(actionId, "error")
        if (ScreenJournal.get(app, actionId) == null) ScreenJournal.move(app, task.taskId, actionId, Event.HOLD)
        val located = locate(actionId, answer.action) ?: return false
        val own = ownClass(answer.action, located)
        if (own.first > answer.cls && actionId !in holds) return hold(actionId, own)
        val shown = ScreenLogic.higher(answer.cls to Why.of(answer.why), own)
        notifyApproval(answer, located, shown.second)
        return awaitRelease(actionId)
    }

    /** `held → started` once, only after fresh checks: stop flag, allowlist, one node, class, grant. */
    private fun released(answer: Answer.Released): Boolean {
        val actionId = answer.actionId
        replayed(actionId, allowHeld = true)?.let { return it }
        if (!ScreenLogic.validAction(answer.action, task.inputs.size)) return refuseAndEnd(actionId, "error")
        // Approved in the chat while the phone never saw the approval: it was held all along.
        if (ScreenJournal.get(app, actionId) == null) ScreenJournal.move(app, task.taskId, actionId, Event.HOLD)
        if (task.stopped) return refuseAndEnd(actionId, "stopped")
        if (ScreenAllowStore.get(app, task.packageName) == null) return refuseAndEnd(actionId, "not_allowed")
        // Approved in the chat on this phone: the bot's own app is in front now.
        // Bring the task's app back as it was; the binding still decides.
        if (!ops.inFront()) ops.open(task.deadline)?.let { return refuseAndEnd(actionId, it) }
        val located = locate(actionId, answer.action) ?: return false
        val own = ownClass(answer.action, located)
        ScreenLogic.grantProblem(
            answer.grant, task.taskId, step, actionId, answer.action, task.packageName, own.first, System.currentTimeMillis(),
        )?.let { return refuseAndEnd(actionId, it) }
        return dispatch(actionId, answer.action, located.target)
    }

    /**
     * A retry of step N whose action the journal already has (plan §1): it is
     * never acted on again. A final status is reported as it is; `started`
     * may have run and ends the task `uncertain`. Null: not journaled (or
     * held, when [allowHeld]) — go on.
     */
    private fun replayed(actionId: String, allowHeld: Boolean): Boolean? {
        val status = ScreenJournal.get(app, actionId) ?: return null
        return when (status) {
            Status.HELD -> if (allowHeld) null else refuseAndEnd(actionId, "error")
            Status.STARTED -> {
                ScreenJournal.move(app, task.taskId, actionId, Event.UNCERTAIN)
                endFalse("uncertain", Report(actionId, Status.UNCERTAIN))
            }
            Status.UNCERTAIN -> endFalse("uncertain", Report(actionId, Status.UNCERTAIN))
            else -> {
                report = Report(actionId, status)
                step++
                true
            }
        }
    }

    // -- holding and waiting for the user ----------------------------------------------

    /** Tells the server the phone classes this action higher; its answer is handled as any other. */
    private fun hold(actionId: String, own: Pair<Cls, Why?>): Boolean {
        if (!holds.add(actionId)) return refuseAndEnd(actionId, "error")
        val body = Protocol.screenHoldBody(task.taskId, step, actionId, own.first, own.second)
        return when (val ex = exchange(body)) {
            is Ex.Fail -> refuseAndEnd(actionId, ex.code)
            is Ex.Got -> handle(ex.answer)
        }
    }

    /**
     * Held until the server says: woken at once by FCM `screen_release` or a
     * verdict tap, with backup polls at 3, 5, 8, 10, 10… s, the stop flag read
     * every [TICK_MS], and never past the deadline.
     */
    private fun awaitRelease(actionId: String): Boolean {
        var polls = 0
        var nextPoll = now() + ScreenLogic.pollDelayMs(polls)
        while (true) {
            if (task.stopped) return refuseAndEnd(actionId, "stopped")
            if (late()) return refuseAndEnd(actionId, "deadline")
            if (task.woken || now() >= nextPoll) {
                task.woken = false
                val reply = Api.screenStep(app, Protocol.screenPollBody(task.taskId, step), task.newCall())
                if (task.stopped) continue
                polls++
                var delay = ScreenLogic.pollDelayMs(polls)
                when (reply) {
                    is Api.ScreenReply.Answer -> when (val answer = reply.answer) {
                        is Answer.Approval -> if (answer.actionId != actionId) return refuseAndEnd(actionId, "error")
                        is Answer.Released -> {
                            ScreenNotifications.cancelApproval(app, actionId)
                            return if (answer.actionId == actionId && answer.step == step) released(answer) else refuseAndEnd(actionId, "error")
                        }
                        is Answer.Wait -> delay = ScreenLogic.retryDelayMs(answer.retryAfterMs)
                        is Answer.End, is Answer.Stopped -> {
                            // Rejected, expired, or ended on the server: nothing runs.
                            ScreenJournal.move(app, task.taskId, actionId, Event.REFUSE)
                            ScreenNotifications.cancelApproval(app, actionId)
                            quiet()
                            return false
                        }
                        is Answer.Act -> return refuseAndEnd(actionId, "error")
                    }
                    Api.ScreenReply.Unreachable -> Unit
                    Api.ScreenReply.Refused -> return refuseAndEnd(actionId, "error")
                }
                nextPoll = now() + delay
            }
            SystemClock.sleep(TICK_MS)
        }
    }

    private fun notifyApproval(answer: Answer.Approval, located: Located, why: Why?) {
        val target = located.target
        val name = target?.let { ScreenLogic.fullLabel(it.nodes, it.index) ?: it.node.hint?.trim()?.ifEmpty { null } }
        val label = name?.let { Ui.isolate("\"${ScreenLogic.cut(it)}\"") } ?: app.getString(R.string.screen_unnamed)
        val what = when (answer.action.kind) {
            "tap" -> app.getString(R.string.screen_action_tap, label)
            "submit" -> app.getString(R.string.screen_action_submit, label)
            // The approved input is named by its number only, never shown.
            "type" -> app.getString(R.string.screen_action_type, app.getString(R.string.screen_input, answer.action.input), label)
            else -> app.getString(R.string.screen_action_other)
        }
        val reason = app.getString(
            when (why) {
                Why.SENSITIVE -> R.string.screen_why_sensitive
                Why.UNLABELLED -> R.string.screen_why_unlabelled
                Why.AFTER_FORM -> R.string.screen_why_after_form
                Why.ASK_EVERY_TAP -> R.string.screen_why_ask_every_tap
                Why.SUBMIT_NOT_SEARCH -> R.string.screen_why_submit_not_search
                Why.GENERIC, null -> R.string.screen_why_generic
            },
        )
        ScreenNotifications.showApproval(app, task.taskId, answer.actionId, answer.nonce, task.label, what, reason)
    }

    // -- acting ----------------------------------------------------------------------------

    /** A fresh snapshot and the one node of the action's binding; on none or several, refused and ended. */
    private fun locate(actionId: String, action: ScreenLogic.Action): Located? {
        if (!action.bound) return Located(null)
        val binding = action.b ?: return null
        return when (val found = ops.find(binding, task.deadline)) {
            is Found.One -> Located(found.target)
            is Found.Refused -> {
                refuseAndEnd(actionId, if (task.stopped) "stopped" else found.reason)
                null
            }
        }
    }

    /** The phone's own class, with its own "ask before every tap" and its own record of typing. */
    private fun ownClass(action: ScreenLogic.Action, located: Located): Pair<Cls, Why?> {
        // An app no longer listed asks about everything (and the loop ends at its next check).
        val ask = ScreenAllowStore.get(app, task.packageName)?.askEveryTap ?: true
        val target = located.target ?: return ScreenLogic.riskClass(action.kind, null, ask, typedNonSearch)
        return ScreenLogic.ownClass(action.kind, target.nodes, target.index, task.packageName, ask, typedNonSearch)
    }

    /**
     * The dispatch gate: `synchronized(gate) { stopped? → refuse; last checks;
     * journal started (commit); perform; journal outcome (commit) }`. A stop
     * takes the same lock, so it lands before or after a whole action.
     */
    private fun dispatch(actionId: String, action: ScreenLogic.Action, target: Target?): Boolean {
        var refusal: String? = null
        var outcome: Status? = null
        synchronized(task.gate) {
            if (task.stopped) {
                refusal = "stopped"
            } else {
                val problem = ops.ready(action, target)
                if (problem != null) {
                    refusal = problem
                } else if (ScreenJournal.move(app, task.taskId, actionId, Event.START) == null) {
                    refusal = "error"
                } else {
                    val input = if (action.kind == "type") task.inputs.getOrNull(action.input - 1) else null
                    val accepted = try {
                        ops.fire(action, target, input)
                    } catch (_: Exception) {
                        null
                    }
                    val event = when (accepted) {
                        true -> Event.DISPATCHED
                        false -> Event.NOT_ACCEPTED
                        null -> Event.UNCERTAIN
                    }
                    outcome = ScreenJournal.move(app, task.taskId, actionId, event)
                }
            }
        }
        ScreenNotifications.cancelApproval(app, actionId)
        refusal?.let { return refuseAndEnd(actionId, it) }

        val status = outcome ?: Status.UNCERTAIN
        if (status == Status.UNCERTAIN) return endFalse("uncertain", Report(actionId, Status.UNCERTAIN))
        report = Report(actionId, status)
        if (status == Status.DISPATCHED) {
            when (action.kind) {
                "wait" -> pause(action.seconds * 1_000L)
                "back" -> if (!ops.stillInApp(task.deadline)) {
                    if (task.stopped) stopped(report) else end("left_app", report)
                    return false
                }
                "type" -> {
                    val field = target?.let { ScreenLogic.elementAt(it.nodes, it.index, task.packageName) }
                    if (!ScreenLogic.isSearchField(field)) typedNonSearch = true
                }
            }
        }
        step++
        return true
    }

    // -- endings ---------------------------------------------------------------------------

    private fun refuseAndEnd(actionId: String, code: String): Boolean {
        ScreenJournal.move(app, task.taskId, actionId, Event.REFUSE)
        ScreenNotifications.cancelApproval(app, actionId)
        val reason = if (code == "stopped") stopCode() else ScreenLogic.endCode(code)
        failWith(code, Report(actionId, Status.REFUSED, reason))
        return false
    }

    private fun stopCode(): String = when (task.stopBy) {
        ScreenAgentRunner.StopBy.REMOVED -> "not_allowed"
        else -> "stopped_user"
    }

    private fun failWith(code: String, report: Report?) {
        if (code == "stopped") stopped(report) else end(code, report)
    }

    private fun endFalse(code: String, report: Report? = null): Boolean {
        end(code, report)
        return false
    }

    /** The phone ends the task, with [report] when an action's outcome is still owed. */
    private fun end(code: String, report: Report?) {
        if (finished) return
        finished = true
        ScreenAgentRunner.result(app, task.taskId, code, report)
    }

    /** Stopped on the phone: "עצור" and an allowlist removal are reported; a server stop or a routine is not. */
    private fun stopped(report: Report?) {
        if (finished) return
        finished = true
        when (task.stopBy) {
            ScreenAgentRunner.StopBy.USER -> ScreenAgentRunner.result(app, task.taskId, "stopped_user", report)
            ScreenAgentRunner.StopBy.REMOVED -> ScreenAgentRunner.result(app, task.taskId, "not_allowed", report)
            else -> Unit
        }
    }

    /** The server ended the task itself (`end`, `stopped`): its chat message says how. */
    private fun quiet() {
        finished = true
    }

    /** An exception escaped the loop: an action that may have run is `uncertain`, else `error`. */
    fun crashed() {
        val started = ScreenJournal.entries(app).firstOrNull { it.taskId == task.taskId && it.status == Status.STARTED }
        if (started != null) {
            ScreenJournal.move(app, task.taskId, started.actionId, Event.UNCERTAIN)
            end("uncertain", Report(started.actionId, Status.UNCERTAIN))
        } else {
            end("error", report)
        }
    }

    /** After the loop: nothing stays held or started, and the task's journal is cleared. */
    fun cleanUp() {
        for (entry in ScreenJournal.entries(app).filter { it.taskId == task.taskId }) {
            when (entry.status) {
                Status.HELD -> {
                    ScreenJournal.move(app, task.taskId, entry.actionId, Event.REFUSE)
                    ScreenNotifications.cancelApproval(app, entry.actionId)
                }
                Status.STARTED -> {
                    ScreenJournal.move(app, task.taskId, entry.actionId, Event.UNCERTAIN)
                    end("uncertain", Report(entry.actionId, Status.UNCERTAIN))
                }
                else -> Unit
            }
        }
        if (!finished) {
            if (task.stopped) stopped(report) else end("error", report)
        }
        ScreenJournal.clearTask(app, task.taskId)
    }

    // -- time ------------------------------------------------------------------------------

    private fun now(): Long = SystemClock.uptimeMillis()

    private fun late(): Boolean = now() >= task.deadline

    /** Sleeps [ms], waking every [TICK_MS] to look at the stop flag and the deadline. */
    private fun pause(ms: Long) {
        val until = now() + ms
        while (now() < until && !task.stopped && !late()) SystemClock.sleep(TICK_MS)
    }

    private companion object {
        const val TICK_MS = 250L
        const val RETRY_MS = 2_000L
        /** Answers missing in a row before the task ends `unreachable`. */
        const val MAX_FAILURES = 3
        /** Reads of a screen with nothing labelled to tap, a second apart, before it is sent as it is. */
        const val UNUSABLE_REREADS = 6
        const val UNUSABLE_WAIT_MS = 1_000L
    }
}
