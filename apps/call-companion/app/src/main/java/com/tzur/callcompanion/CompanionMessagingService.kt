package com.tzur.callcompanion

import android.Manifest
import android.content.pm.PackageManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Woken by FCM, which carries no content at all (PLAN §6.17, §6.18):
 *
 * - `kind: outbox` — something is waiting. Fetch, store, ack, notify. Every
 *   such push ends in something visible: the rows, or a generic line when the
 *   fetch failed, so a reminder never rings silently.
 * - `dispatch_id` — a call request. The words to match are fetched over HTTPS,
 *   signed, so the name never passes through Google.
 * - `kind: calls_report` — the digest asks for the calls missed in the last
 *   day (2026-10-06). Answered signed, with names only; nothing is shown.
 */
class CompanionMessagingService : FirebaseMessagingService() {
    private companion object {
        const val DAY_MS = 24 * 60 * 60 * 1000L
    }

    /** Runs on a background thread, with about ten seconds: the network calls here are fine. */
    override fun onMessageReceived(message: RemoteMessage) {
        if (!Signer(this).isPaired) return
        if (message.data["kind"] == "outbox") return onOutbox()
        if (message.data["kind"] == "calls_report") return onCallsReport()
        val dispatchId = message.data["dispatch_id"] ?: return
        onDispatch(dispatchId)
    }

    private fun onOutbox() {
        val outcome = Sync.run(this, Api.PUSH_TIMEOUT_MS)
        if (!outcome.ok && outcome.fresh.isEmpty()) {
            if (!ChatEvents.foreground) Notifier.generic(this)
            return
        }
        Notifier.announce(this, outcome.fresh)
    }

    /** Without the permission the phone does not answer, and the digest goes out without the line. */
    private fun onCallsReport() {
        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return
        val since = System.currentTimeMillis() - DAY_MS
        Api.callsReport(this, PhoneReads.callLog(this, since, missedOnly = true))
    }

    private fun onDispatch(dispatchId: String) {
        val dispatch = Api.fetchDispatch(this, dispatchId) ?: return

        // A push delivered late to a phone that was off must not ring anybody.
        if (System.currentTimeMillis() >= dispatch.expiresAt) return

        if (checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            // Nothing is reported: the request expires on the server and the
            // reply says the phone was not available, which is the truth.
            CallNotifier.showNeedsContacts(this)
            return
        }

        val match = ContactMatcher.match(dispatch.queryVariants, ContactsReader.read(this))
        if (match.candidates.isEmpty()) {
            Reports.send(this, dispatchId, "none", "no_match")
            CallNotifier.showNoMatch(this, dispatch.queryVariants.firstOrNull() ?: "")
            return
        }

        // The fullest words, to say what was not found when only part matched.
        val heard = dispatch.queryVariants.maxByOrNull { it.trim().split(Regex("\\s+")).size } ?: ""
        CallNotifier.show(this, CallRequest(dispatchId, dispatch.expiresAt, match.candidates, match.partial, heard))
    }

    /** FCM rotated this phone's address. Without telling the server, nothing arrives. */
    override fun onNewToken(token: String) {
        if (!Signer(this).isPaired) return
        if (Api.updatePushToken(this, token)) PushToken.markSent(this)
    }
}
