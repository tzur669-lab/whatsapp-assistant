package com.tzur.callcompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** "ביטול" on the notification: no call, and one report saying so. */
class CancelReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val request = CallRequest.from(intent) ?: return
        CallNotifier.dismiss(context, request.dispatchId)
        Reports.send(context, request.dispatchId, request.matched, "cancelled")
    }
}
