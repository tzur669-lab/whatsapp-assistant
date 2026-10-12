package com.tzur.callcompanion

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import org.json.JSONArray
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A screen task on the phone, from the push to the end (0.14,
 * `docs/plans/screen-agent.md`). The loop runs on the server; the phone is
 * its eyes and hands, and has the last word on every action.
 *
 * 1. FCM `screen` wakes the app with the task id. The service off →
 *    `service_off`; a locked phone is unlocked first (`RoutineRunActivity`).
 * 2. One signed claim: the app, the approved inputs (kept in memory only), the
 *    deadline. The app must be on this phone's allowlist.
 * 3. The app comes to the front as it was (never `CLEAR_TASK`).
 * 4. Up to 12 steps: the screen as elements → `/app/screen/step` → one action.
 *    Before acting: the stop flag, the journal, a fresh snapshot with exactly
 *    one node of the action's binding, and the phone's own risk class. A
 *    higher class than the server's is held and asked about.
 *
 * At most once: every action goes through one gate —
 * `synchronized(gate) { stopped? → refuse; journal started; perform; journal outcome }` —
 * and a stop sets the flag inside the same gate, so once [stop] returns no
 * action starts. An action whose outcome the journal never got is reported
 * `uncertain` and never repeated.
 *
 * Runs on [RoutineAccessibilityService]'s one worker, so a routine and a task
 * never act at once. A routine push stops the task first.
 */
object ScreenAgentRunner {

    enum class StopBy {
        /** "עצור" on the notification: reported `stopped_user`. */
        USER,
        /** `screen_stop`, or the server's own `stopped`/`end`: nothing to report. */
        SERVER,
        /** A routine is due (the server preempts the task itself). */
        ROUTINE,
        /** The user took the app off the allowlist: reported `not_allowed`. */
        REMOVED,
    }

    /** One claimed task. The inputs live only here, in memory. */
    internal class Task(
        val taskId: String,
        val packageName: String,
        val label: String,
        val inputs: List<String>,
        /** On [SystemClock.uptimeMillis]. */
        val deadline: Long,
        val maxSteps: Int,
    ) {
        val gate = Any()
        @Volatile var stopped = false
        @Volatile var stopBy: StopBy? = null
        /** Set by `screen_release` or a verdict tap: the approval wait polls at once. */
        @Volatile var woken = false
        @Volatile var call: Api.Abortable? = null

        /** A fresh abortable for the next request; aborted at once if the task already stopped. */
        fun newCall(): Api.Abortable = Api.Abortable().also {
            call = it
            if (stopped) it.abort()
        }
    }

    private const val PREFS = "screen_reports"
    private const val KEY = "pending"
    private const val REPORT_ATTEMPTS = 3
    private const val CLAIM_ATTEMPTS = 2

    @Volatile internal var current: Task? = null
    /** Tasks pushed but not started yet, so a stop before the claim still counts. */
    private val waiting = ConcurrentHashMap.newKeySet<String>()
    private val stoppedEarly = ConcurrentHashMap.newKeySet<String>()
    private val recovered = AtomicBoolean(false)
    private val synced = AtomicBoolean(false)

    // -- from the push ------------------------------------------------------------

    /** FCM `screen`, on FCM's thread. */
    fun onPush(context: Context, taskId: String) {
        if (!ScreenLogic.ID.matches(taskId)) return
        val app = context.applicationContext
        recover(app)
        if (!RoutineAccessibilityService.isOn) {
            result(app, taskId, "service_off", null)
            return
        }
        val keyguard = app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (keyguard.isKeyguardLocked) {
            waiting.add(taskId)
            app.startActivity(
                Intent(app, RoutineRunActivity::class.java)
                    .putExtra(RoutineRunActivity.EXTRA_SCREEN_TASK_ID, taskId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
            return
        }
        start(app, taskId)
    }

    /** After the unlock, or with the phone already open. Queues the task on the service's worker. */
    fun start(context: Context, taskId: String) {
        val app = context.applicationContext
        waiting.add(taskId)
        val queued = RoutineAccessibilityService.screenTask { ops ->
            try {
                run(app, taskId, ops)
            } finally {
                waiting.remove(taskId)
                stoppedEarly.remove(taskId)
            }
        }
        if (!queued) {
            waiting.remove(taskId)
            result(app, taskId, "service_off", null)
        }
    }

    /** The phone stayed locked: nothing was claimed, nothing ran. */
    fun lockedOut(context: Context, taskId: String) {
        waiting.remove(taskId)
        result(context.applicationContext, taskId, "locked", null)
    }

    /** FCM `screen_release`, or a verdict tap: the approval wait asks the server now. */
    fun wake(taskId: String) {
        current?.takeIf { it.taskId == taskId }?.woken = true
    }

    // -- stopping -----------------------------------------------------------------

    /**
     * Stops [taskId]: inside the gate, so no new action starts once this
     * returns; then the request in flight is aborted and any wait wakes. A
     * task not started yet never starts. Never call on the main thread (the
     * abort closes a socket).
     */
    fun stop(taskId: String, by: StopBy) {
        val task = current
        if (task != null && task.taskId == taskId) stopTask(task, by) else stoppedEarly.add(taskId)
    }

    /** A routine push: whatever task runs or waits, stops. */
    fun stopAll(by: StopBy) {
        current?.let { stopTask(it, by) }
        stoppedEarly.addAll(waiting)
    }

    /** The app was taken off the allowlist: a task in it stops at once. */
    fun stopPackage(packageName: String) {
        val task = current?.takeIf { it.packageName == packageName } ?: return
        Thread { stopTask(task, StopBy.REMOVED) }.start()
    }

    private fun stopTask(task: Task, by: StopBy) {
        synchronized(task.gate) {
            if (!task.stopped) {
                task.stopBy = by
                task.stopped = true
            }
        }
        task.call?.abort()
        task.woken = true
    }

    // -- the run --------------------------------------------------------------------

    private fun run(
        app: Context,
        taskId: String,
        opsFor: (String, () -> Boolean) -> RoutineAccessibilityService.ScreenOps?,
    ) {
        if (stoppedEarly.remove(taskId)) return
        var claim: Api.ScreenClaim = Api.ScreenClaim.Unreachable
        for (attempt in 1..CLAIM_ATTEMPTS) {
            claim = Api.claimScreen(app, taskId)
            if (claim !is Api.ScreenClaim.Unreachable) break
        }
        // Refused (late, already, stopped) or unreachable: the server tells the user; nothing runs.
        val ok = claim as? Api.ScreenClaim.Ok ?: return
        val claimedAt = SystemClock.uptimeMillis()

        // The phone has the last word: only an app on its own allowlist, never a blocked one.
        val allowed = ScreenAllowStore.get(app, ok.packageName)
        if (allowed == null || ScreenLogic.blocked(ok.packageName, app.packageName)) {
            result(app, taskId, "not_allowed", null)
            return
        }
        val task = Task(
            taskId = taskId,
            packageName = ok.packageName,
            label = allowed.label.ifBlank { ok.label },
            inputs = ok.inputs,
            deadline = ScreenLogic.phoneDeadline(claimedAt, System.currentTimeMillis(), ok.deadlineAt),
            maxSteps = minOf(ok.maxSteps, ScreenLogic.MAX_STEPS),
        )
        current = task
        if (stoppedEarly.remove(taskId)) stopTask(task, StopBy.SERVER)
        ScreenJournal.setActive(app, taskId)
        ScreenNotifications.showRunning(app, taskId, task.label)
        val loop = ScreenRun(app, task)
        try {
            val ops = opsFor(task.packageName) { task.stopped }
            if (ops == null) {
                result(app, taskId, "service_off", null)
            } else {
                loop.start(ops)
            }
        } catch (_: Exception) {
            // An Android error mid-task: if an action may have run, say so.
            loop.crashed()
        } finally {
            current = null
            ScreenNotifications.cancelRunning(app)
            loop.cleanUp()
            ScreenJournal.setActive(app, null)
        }
    }

    // -- process start --------------------------------------------------------------

    /**
     * Once per process, before any task (from [CompanionApp]): a `held` action
     * becomes `refused` and its task is reported `stopped_restart`; a
     * `started` one becomes `uncertain` and is reported `uncertain` — it may
     * have run, and is never repeated. A task that was running with nothing
     * open is closed too. Reports are kept first, then sent.
     */
    fun recover(context: Context) {
        if (!recovered.compareAndSet(false, true)) return
        val app = context.applicationContext
        val entries = ScreenJournal.entries(app)
        val active = ScreenJournal.active(app)
        if (entries.isEmpty() && active == null) return
        val owed = LinkedHashMap<String, Pair<String, ScreenLogic.Report?>>()
        for (entry in entries) {
            when (entry.status) {
                ScreenLogic.Status.STARTED -> {
                    ScreenJournal.move(app, entry.taskId, entry.actionId, ScreenLogic.Event.RESTART)
                    owed[entry.taskId] = "uncertain" to ScreenLogic.Report(entry.actionId, ScreenLogic.Status.UNCERTAIN)
                }
                ScreenLogic.Status.HELD -> {
                    ScreenJournal.move(app, entry.taskId, entry.actionId, ScreenLogic.Event.RESTART)
                    if (owed[entry.taskId]?.first != "uncertain") {
                        owed[entry.taskId] = "stopped_restart" to
                            ScreenLogic.Report(entry.actionId, ScreenLogic.Status.REFUSED, "stopped_restart")
                    }
                }
                else -> Unit
            }
        }
        active?.let { if (it !in owed) owed[it] = "stopped_restart" to null }
        for ((taskId, pair) in owed) keep(app, Protocol.screenResultBody(taskId, pair.first, pair.second))
        ScreenJournal.clearAll(app)
        if (owed.isNotEmpty() && Signer(app).isPaired) Thread { flush(app) }.start()
    }

    // -- reports and the allowlist's sync ---------------------------------------------

    /** Ends a task from the phone (`/app/screen/result`), on a background thread; kept if unreachable. */
    internal fun result(context: Context, taskId: String, reason: String, report: ScreenLogic.Report?) {
        val app = context.applicationContext
        val body = Protocol.screenResultBody(taskId, reason, report)
        Thread {
            for (attempt in 1..REPORT_ATTEMPTS) {
                if (Api.screenResult(app, body)) return@Thread
                Thread.sleep(2_000L * attempt)
            }
            keep(app, body)
        }.start()
    }

    /** The server's copy of the allowlist: after every change. */
    fun syncAllow(context: Context) {
        val app = context.applicationContext
        if (!Signer(app).isPaired) return
        Thread { Api.syncScreenAllow(app, ScreenAllowStore.all(app)) }.start()
    }

    /** Once per process, from the chat: the allowlist, and any report that waited. */
    fun syncOnce(context: Context) {
        if (!synced.compareAndSet(false, true)) return
        val app = context.applicationContext
        if (!Signer(app).isPaired) return
        Thread {
            Api.syncScreenAllow(app, ScreenAllowStore.all(app))
            flush(app)
        }.start()
    }

    @Synchronized
    private fun keep(context: Context, body: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = try { JSONArray(prefs.getString(KEY, "[]")) } catch (_: Exception) { JSONArray() }
        list.put(body)
        prefs.edit().putString(KEY, list.toString()).commit()
    }

    @Synchronized
    private fun flush(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = try { JSONArray(prefs.getString(KEY, "[]")) } catch (_: Exception) { JSONArray() }
        if (list.length() == 0) return
        val left = JSONArray()
        for (i in 0 until list.length()) {
            val body = list.optString(i)
            if (body.isNotEmpty() && !Api.screenResult(context, body)) left.put(body)
        }
        prefs.edit().putString(KEY, left.toString()).commit()
    }
}
