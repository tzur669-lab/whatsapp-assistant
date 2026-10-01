package com.tzur.callcompanion

import android.app.Activity
import android.content.Context
import android.widget.Toast

/**
 * A card's way from the chat to the phone (PLAN §6.20):
 *
 *   take it here (once) → claim it on the server (once) → run it → report.
 *
 * The parameters exist on this phone only after the claim succeeds, and the
 * server answers a second claim with "used". So a card fetched twice, tapped
 * twice, or auto-run and then tapped still runs once.
 */
object Cards {
    /** A card the server allows to run alone does so only while fresh and on screen. */
    private const val AUTO_RUN_WINDOW_MS = 2 * 60_000L

    fun shouldAutoRun(message: ChatStore.Message): Boolean {
        val card = message.card ?: return false
        return card.autoRun && message.cardState == ChatStore.CARD_OPEN && message.seq != null &&
            System.currentTimeMillis() - message.arrivedAt < AUTO_RUN_WINDOW_MS
    }

    fun run(activity: Activity, seq: Long, card: Row.Card) {
        val store = ChatStore.get(activity)
        if (!store.takeCard(seq)) return
        ChatEvents.changed()
        val app = activity.applicationContext

        Thread {
            when (val claim = Api.claim(app, card, "ok")) {
                is Api.Claim.Ok -> activity.runOnUiThread {
                    if (activity.isFinishing || activity.isDestroyed) {
                        // Claimed but never shown: say so rather than run it unseen.
                        finish(app, seq, card, "failed")
                    } else {
                        DeviceActions.run(activity, claim.action) { outcome -> finish(app, seq, card, outcome) }
                    }
                }
                is Api.Claim.Refused -> {
                    store.setCardState(seq, if (claim.reason == "expired") ChatStore.CARD_EXPIRED else ChatStore.CARD_REFUSED)
                    ChatEvents.changed()
                }
                Api.Claim.Cancelled -> {
                    store.setCardState(seq, ChatStore.CARD_REFUSED)
                    ChatEvents.changed()
                }
                Api.Claim.Unreachable -> {
                    // Nothing was spent on the server: the card can be tapped again.
                    store.setCardState(seq, ChatStore.CARD_OPEN)
                    ChatEvents.changed()
                    activity.runOnUiThread { Toast.makeText(app, R.string.card_no_connection, Toast.LENGTH_LONG).show() }
                }
            }
        }.start()
    }

    fun refuse(activity: Activity, seq: Long, card: Row.Card) {
        val store = ChatStore.get(activity)
        if (!store.takeCard(seq)) return
        ChatEvents.changed()
        val app = activity.applicationContext
        Thread {
            val claim = Api.claim(app, card, "no")
            store.setCardState(seq, if (claim is Api.Claim.Unreachable) ChatStore.CARD_OPEN else ChatStore.CARD_REFUSED)
            ChatEvents.changed()
        }.start()
    }

    private fun finish(app: Context, seq: Long, card: Row.Card, outcome: String) {
        ChatStore.get(app).setCardState(seq, if (outcome == "done") ChatStore.CARD_DONE else ChatStore.CARD_FAILED)
        ChatEvents.changed()
        Thread { Api.reportAction(app, card.actionId, outcome) }.start()
    }
}
