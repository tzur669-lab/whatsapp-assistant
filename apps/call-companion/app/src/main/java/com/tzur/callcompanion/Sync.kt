package com.tzur.callcompanion

import android.content.Context

/**
 * Fetch the outbox, store it, ack what was stored (PLAN §6.18).
 *
 * The order is the guarantee: a row is acked only after it is committed
 * here, and the ack names its seqs. A crash between the two costs a second
 * fetch of rows already stored, which [ChatStore.saveRows] ignores — never a
 * lost row.
 */
object Sync {
    class Outcome(val ok: Boolean, val fresh: List<Row>)

    private const val MAX_PAGES = 5
    private val lock = Any()

    fun run(context: Context, timeoutMs: Int): Outcome = synchronized(lock) {
        val store = ChatStore.get(context)
        val fresh = mutableListOf<Row>()
        repeat(MAX_PAGES) {
            val (result, page) = Api.fetchOutbox(context, timeoutMs)
            if (result is Api.Result.Unpaired) ChatEvents.unpaired()
            if (page == null) return Outcome(false, fresh)

            // Whether a smart conversation can be offered (0.12): on every fetch, so it follows the server.
            page.smart?.let { ServerStatus.setSmart(context, it) }

            val saved = store.saveRows(page.rows)
            fresh += saved
            if (fresh.isNotEmpty()) ChatEvents.changed()
            // The home-screen widget shows the newest reminder (0.11).
            AssistantWidget.record(context, saved)

            val acked = Api.ack(context, page.rows.map { it.seq }.filter { it > 0 }, timeoutMs)
            // Unacked rows come back first on the next page; stop rather than re-read them.
            if (!acked || !page.more) return Outcome(true, fresh)
        }
        Outcome(true, fresh)
    }
}

/**
 * What the server last said about itself (0.12): whether it can run a smart
 * conversation. Null until a server that says so has been asked — the new
 * conversation dialog then offers local only.
 */
object ServerStatus {
    private const val PREFS = "server"
    private const val KEY_SMART = "smart"

    fun smart(context: Context): Boolean? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return if (prefs.contains(KEY_SMART)) prefs.getBoolean(KEY_SMART, false) else null
    }

    fun setSmart(context: Context, smart: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_SMART, smart).apply()
    }
}
