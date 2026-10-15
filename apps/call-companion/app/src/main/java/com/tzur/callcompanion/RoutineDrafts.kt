package com.tzur.callcompanion

import android.os.SystemClock
import com.tzur.callcompanion.RoutineLogic.Step
import java.util.UUID

/**
 * The one routine draft recorded from a screen task (plan
 * `docs/plans/routine-from-screen-task.md`, decision 3): in memory only, for
 * the process's lifetime, at most [TTL_MS]. Never written to storage, sent,
 * logged or put in history. A newer draft replaces it; save and discard act
 * only on the [Draft.id] the review screen opened, so a stale id finds nothing.
 *
 * [offer] runs on the accessibility service's worker thread and the rest on
 * the main thread: every method holds one lock, and a draft is an immutable
 * value swapped whole.
 */
class RoutineDrafts(private val clock: () -> Long) {

    data class Draft(
        val id: String,
        val packageName: String,
        val appLabel: String,
        val steps: List<Step>,
        /** Indexes of steps the user approved during the task. */
        val marked: Set<Int>,
        /** On [clock]; the draft expires [TTL_MS] after it. */
        val madeAt: Long,
    )

    private val lock = Any()
    private var draft: Draft? = null

    /** Keeps [steps] as the one draft, replacing any other. Returns its id. */
    fun offer(packageName: String, appLabel: String, steps: List<Step>, marked: Set<Int>): String = synchronized(lock) {
        val id = UUID.randomUUID().toString()
        draft = Draft(id, packageName, appLabel, steps.toList(), marked.toSet(), clock())
        id
    }

    /** The draft with [id], or null when it was replaced, expired or never existed. */
    fun get(id: String): Draft? = synchronized(lock) { live(id) }

    /** The review screen's working copy, after an edit. False: [id] is stale. */
    fun update(id: String, steps: List<Step>, marked: Set<Int>): Boolean = synchronized(lock) {
        val current = live(id) ?: return false
        draft = current.copy(steps = steps.toList(), marked = marked.toSet())
        true
    }

    /** Removes and returns the draft with [id] (Save). Null: stale. */
    fun take(id: String): Draft? = synchronized(lock) {
        live(id)?.also { draft = null }
    }

    /** Discards the draft with [id]; a stale id changes nothing. */
    fun drop(id: String) {
        synchronized(lock) { if (live(id) != null) draft = null }
    }

    /** The live draft, if any (the routines list shows it at the top). */
    fun current(): Draft? = synchronized(lock) { draft?.let { live(it.id) } }

    private fun live(id: String): Draft? {
        val current = draft ?: return null
        if (clock() - current.madeAt >= TTL_MS) {
            draft = null
            return null
        }
        return current.takeIf { it.id == id }
    }

    companion object {
        const val TTL_MS = 30 * 60_000L

        /** The process's one holder, on the clock that does not jump with the wall time. */
        val shared = RoutineDrafts { SystemClock.elapsedRealtime() }
    }
}
