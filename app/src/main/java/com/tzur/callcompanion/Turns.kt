package com.tzur.callcompanion

import android.content.Context
import android.os.SystemClock
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * One message at a time, to its one answer (PLAN §6.18).
 *
 * Messages run on a single thread, so two turns never interleave on the
 * server around the parser's await — a button tapped in a notification waits
 * behind a message being typed. The chat keeps its input locked while [busy].
 *
 * A message that gets no answer is sent again **with the same id** and a new
 * nonce. The server treats the id as the dedupe key, so a retry never runs the
 * message twice: it answers with the stored reply, or says the first attempt
 * is still running (`pending`), finished silently (`done`), or died part-way
 * (`unknown`). While pending, the outbox is polled for the answer. After
 * three minutes the app stops waiting and says so — the answer, if it comes,
 * still lands in the chat through the outbox.
 */
object Turns {
    private const val POLL_MS = 5_000L
    private const val GIVE_UP_MS = 3 * 60_000L
    /** While pending, a typed message is asked about again every third poll (it is a few hundred bytes). */
    private const val RESEND_EVERY = 3

    private val executor = Executors.newSingleThreadExecutor()
    private val queued = AtomicInteger(0)

    val busy: Boolean get() = queued.get() > 0

    fun sendText(context: Context, text: String) {
        val app = context.applicationContext
        val id = Protocol.newMessageId()
        ChatStore.get(app).addOutgoing(id, "text", text)
        submit(app, id, null) { run(app, id, cheapResend = true) { Api.sendText(app, id, text) } }
    }

    /** A button under row [seq] — from the chat or from a notification. */
    fun press(context: Context, seq: Long, button: Row.Button, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        if (!Protocol.BUTTON_ID.matches(button.id)) {
            onDone?.invoke()
            return
        }
        val id = Protocol.newMessageId()
        val store = ChatStore.get(app)
        store.markAnswered(seq)
        store.addOutgoing(id, "button", button.title)
        submit(app, id, onDone) { run(app, id, cheapResend = true) { Api.sendButton(app, id, button.id) } }
    }

    /** A recording, already read into memory; the file is gone by now. */
    fun sendVoice(context: Context, audio: ByteArray, label: String) {
        val app = context.applicationContext
        val id = Protocol.newMessageId()
        ChatStore.get(app).addOutgoing(id, "voice", label)
        // Up to a megabyte: asked about again only when nothing else answers.
        submit(app, id, null) { run(app, id, cheapResend = false) { Api.sendVoice(app, id, audio) } }
    }

    private fun submit(app: Context, id: String, onDone: (() -> Unit)?, work: () -> Unit) {
        queued.incrementAndGet()
        ChatEvents.changed()
        executor.execute {
            try {
                work()
            } catch (_: Exception) {
                // A Keystore or database failure. The message may not have left.
                ChatStore.get(app).setState(id, ChatStore.STATE_FAILED)
            } finally {
                queued.decrementAndGet()
                ChatEvents.changed()
                onDone?.invoke()
            }
        }
    }

    private fun run(app: Context, id: String, cheapResend: Boolean, send: () -> Pair<Api.Result, Api.Answer?>) {
        val store = ChatStore.get(app)
        val deadline = SystemClock.elapsedRealtime() + GIVE_UP_MS

        var attempt = send()
        while (true) {
            val (result, answer) = attempt
            when {
                result is Api.Result.Ok -> {
                    if (settle(app, id, answer)) return
                    store.setState(id, ChatStore.STATE_SENT) // pending: it is there, still running
                    break
                }
                result is Api.Result.Unpaired -> {
                    store.setState(id, ChatStore.STATE_FAILED)
                    ChatEvents.unpaired()
                    return
                }
                result is Api.Result.Clock -> return fail(app, id, R.string.notice_clock)
                result is Api.Result.Refused && result.status < 500 -> return fail(app, id, refusal(result.status))
                else -> {
                    // No answer, or the server failed on the way: the same id again is safe.
                    if (SystemClock.elapsedRealtime() >= deadline) return fail(app, id, R.string.notice_no_connection)
                    Thread.sleep(POLL_MS)
                    attempt = send()
                }
            }
        }

        var polls = 0
        while (SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(POLL_MS)
            Notifier.announce(app, Sync.run(app, Api.SHORT_TIMEOUT_MS).fresh)
            if (store.hasReplyTo(id)) return
            polls++
            if (cheapResend && polls % RESEND_EVERY == 0) {
                val (result, answer) = send()
                if (result is Api.Result.Ok && settle(app, id, answer)) return
            }
        }
        if (!cheapResend) {
            val (result, answer) = send()
            if (result is Api.Result.Ok && settle(app, id, answer)) return
        }
        store.addNotice(app.getString(R.string.notice_slow))
        ChatEvents.changed()
    }

    /** True when this answer ends the turn. */
    private fun settle(app: Context, id: String, answer: Api.Answer?): Boolean {
        val store = ChatStore.get(app)
        return when (answer) {
            is Api.Answer.Reply -> {
                val fresh = store.saveRows(listOf(answer.row))
                store.setState(id, ChatStore.STATE_SENT)
                // Stored first, acked second. A lost ack costs one push, not a message.
                if (answer.row.seq > 0) Api.ack(app, listOf(answer.row.seq), Api.SHORT_TIMEOUT_MS)
                Notifier.announce(app, fresh)
                ChatEvents.changed()
                true
            }
            Api.Answer.Done -> {
                store.setState(id, ChatStore.STATE_SENT)
                true
            }
            Api.Answer.Unknown -> {
                store.setState(id, ChatStore.STATE_SENT)
                store.addNotice(app.getString(R.string.notice_unknown))
                ChatEvents.changed()
                true
            }
            is Api.Answer.DeviceQuery -> {
                // Read here, send it back, and the answer to that is the answer to
                // the message (PLAN §6.21). If it does not arrive, the message is
                // asked about again, gets the same query, and this runs again: the
                // server continues the turn once, however many results reach it.
                val result = PhoneReads.run(app, answer.query)
                val (sent, reply) = Api.deviceResult(app, answer.queryId, result)
                sent is Api.Result.Ok && reply != null && reply !is Api.Answer.DeviceQuery && settle(app, id, reply)
            }
            else -> false
        }
    }

    private fun fail(app: Context, id: String, text: Int) {
        val store = ChatStore.get(app)
        store.setState(id, ChatStore.STATE_FAILED)
        store.addNotice(app.getString(text))
        ChatEvents.changed()
    }

    private fun refusal(status: Int): Int = when (status) {
        404 -> R.string.notice_not_available
        413 -> R.string.notice_too_large
        else -> R.string.notice_refused
    }
}
