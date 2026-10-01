package com.tzur.callcompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A button on a notification — "10 דק׳", "בוצע", "אישור". Not exported: only
 * the app's own immutable PendingIntents reach it (PLAN §6.18).
 *
 * The tap becomes exactly the message the same button in the chat would send.
 * Its answer replaces the notification. If the process is killed before the
 * answer, the server still runs the turn, and the answer — not acked — is
 * pushed again within a minute.
 */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val seq = intent.getLongExtra(Notifier.EXTRA_SEQ, -1L)
        val buttonId = intent.getStringExtra(Notifier.EXTRA_BUTTON_ID) ?: return
        val title = intent.getStringExtra(Notifier.EXTRA_BUTTON_TITLE) ?: return
        if (seq <= 0 || !Protocol.BUTTON_ID.matches(buttonId)) return

        Notifier.cancel(context, seq)
        val pending = goAsync()
        Turns.press(context, seq, Row.Button(buttonId, title)) { pending.finish() }
    }
}
