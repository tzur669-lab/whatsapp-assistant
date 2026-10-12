package com.tzur.callcompanion

import android.content.Context

/**
 * The screen agent's journal (spec G, plan §1 and §9.9): per action, its task
 * id and status — never screen text. Every move is one synchronous
 * `commit()`, so a crash between "started" and the outcome is seen at the
 * next process start ([ScreenAgentRunner.recover]). The moves themselves are
 * [ScreenLogic.next]'s table; a move it does not allow changes nothing.
 */
internal object ScreenJournal {
    private const val PREFS = "screen_journal"
    private const val ACTION = "a:"
    private const val ACTIVE = "active"

    data class Entry(val taskId: String, val actionId: String, val status: ScreenLogic.Status)

    @Synchronized
    fun get(context: Context, actionId: String): ScreenLogic.Status? = read(context, actionId)?.status

    /** The new status, or null when the move is not allowed (nothing is written). */
    @Synchronized
    fun move(context: Context, taskId: String, actionId: String, event: ScreenLogic.Event): ScreenLogic.Status? {
        val to = ScreenLogic.next(read(context, actionId)?.status, event) ?: return null
        prefs(context).edit().putString(ACTION + actionId, "$taskId:${to.wire}").commit()
        return to
    }

    @Synchronized
    fun entries(context: Context): List<Entry> = prefs(context).all.keys
        .filter { it.startsWith(ACTION) }
        .mapNotNull { read(context, it.removePrefix(ACTION)) }

    /** A task's entries, once it ended: nothing can act for it any more. */
    @Synchronized
    fun clearTask(context: Context, taskId: String) {
        val editor = prefs(context).edit()
        entries(context).filter { it.taskId == taskId }.forEach { editor.remove(ACTION + it.actionId) }
        editor.commit()
    }

    @Synchronized
    fun clearAll(context: Context) {
        prefs(context).edit().clear().commit()
    }

    /** The task this process is running, so a restart can close it even with no action journaled. */
    @Synchronized
    fun setActive(context: Context, taskId: String?) {
        val editor = prefs(context).edit()
        if (taskId == null) editor.remove(ACTIVE) else editor.putString(ACTIVE, taskId)
        editor.commit()
    }

    @Synchronized
    fun active(context: Context): String? = prefs(context).getString(ACTIVE, null)

    private fun read(context: Context, actionId: String): Entry? {
        val raw = prefs(context).getString(ACTION + actionId, null) ?: return null
        val taskId = raw.substringBefore(':')
        val status = ScreenLogic.Status.of(raw.substringAfter(':')) ?: return null
        return Entry(taskId, actionId, status)
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
