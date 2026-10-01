package com.tzur.callcompanion

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Keeps the server's copy of this phone's FCM address fresh. The server
 * forgets an address FCM calls unregistered (`E_PUSH_UNREGISTERED`), and only
 * the app can give it a new one — so the app re-sends it on open, at most every
 * few hours, and whenever FCM rotates it.
 */
object PushToken {
    private const val REFRESH_MS = 6 * 60 * 60 * 1000L

    fun refreshIfDue(context: Context) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences("push", Context.MODE_PRIVATE)
        if (System.currentTimeMillis() - prefs.getLong("sent_at", 0L) < REFRESH_MS) return
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            val token = if (task.isSuccessful) task.result else null
            if (token.isNullOrEmpty()) return@addOnCompleteListener
            Thread {
                if (Signer(app).isPaired && Api.updatePushToken(app, token)) markSent(app)
            }.start()
        }
    }

    /** Only the time is kept; the address itself is not worth storing twice. */
    fun markSent(context: Context) {
        context.applicationContext.getSharedPreferences("push", Context.MODE_PRIVATE)
            .edit().putLong("sent_at", System.currentTimeMillis()).apply()
    }
}
