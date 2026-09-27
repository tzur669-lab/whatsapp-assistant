package com.tzur.callcompanion

import android.content.Context
import java.util.Collections

/**
 * The one report per call request: a count and an outcome, nothing else. The
 * server turns it into the one WhatsApp reply (PLAN §6.17).
 */
object Reports {
    /** A tap and a notification action can race; only the first report counts. */
    private val settled: MutableSet<String> = Collections.synchronizedSet(HashSet())

    fun send(context: Context, dispatchId: String, matched: String, outcome: String) {
        if (!settled.add(dispatchId)) return
        val token = TokenVault(context.applicationContext).get() ?: return
        Thread { Api.report(token, dispatchId, matched, outcome) }.start()
    }
}
