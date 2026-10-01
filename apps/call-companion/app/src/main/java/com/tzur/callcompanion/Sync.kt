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

            fresh += store.saveRows(page.rows)
            if (fresh.isNotEmpty()) ChatEvents.changed()

            val acked = Api.ack(context, page.rows.map { it.seq }.filter { it > 0 }, timeoutMs)
            // Unacked rows come back first on the next page; stop rather than re-read them.
            if (!acked || !page.more) return Outcome(true, fresh)
        }
        Outcome(true, fresh)
    }
}
