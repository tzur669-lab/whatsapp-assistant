package com.tzur.callcompanion

import android.content.Context
import java.util.Collections

/**
 * The one report per call request: a count and an outcome, nothing else. The
 * server turns it into the one reply in the chat (PLAN §6.17).
 */
object Reports {
    /** A tap and a notification action can race; only the first report counts. */
    private val settled: MutableSet<String> = Collections.synchronizedSet(HashSet())

    fun send(context: Context, dispatchId: String, matched: String, outcome: String) {
        if (!settled.add(dispatchId)) return
        val app = context.applicationContext
        Thread { Api.report(app, dispatchId, matched, outcome) }.start()
    }
}
