package com.tzur.callcompanion

import android.Manifest
import android.content.pm.PackageManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Woken by FCM with an opaque dispatch id and nothing else (PLAN §6.17). The
 * words to match are fetched over HTTPS with this phone's own token, so the
 * name never passes through Google.
 */
class CompanionMessagingService : FirebaseMessagingService() {

    /** Runs on a background thread, so the network calls here are fine. */
    override fun onMessageReceived(message: RemoteMessage) {
        val dispatchId = message.data["dispatch_id"] ?: return
        val token = TokenVault(this).get() ?: return
        val dispatch = Api.fetchDispatch(token, dispatchId) ?: return

        // A push delivered late to a phone that was off must not ring anybody.
        if (System.currentTimeMillis() >= dispatch.expiresAt) return

        if (checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            // Nothing is reported: the request expires on the server and the
            // reply says the phone was not available, which is the truth.
            CallNotifier.showNeedsContacts(this)
            return
        }

        val candidates = ContactMatcher.match(dispatch.queryVariants, ContactsReader.read(this))
        if (candidates.isEmpty()) {
            Reports.send(this, dispatchId, "none", "no_match")
            CallNotifier.showNoMatch(this, dispatch.queryVariants.firstOrNull() ?: "")
            return
        }

        CallNotifier.show(this, CallRequest(dispatchId, dispatch.expiresAt, candidates))
    }

    /** FCM rotated this phone's address. Without telling the server, calls stop arriving. */
    override fun onNewToken(token: String) {
        val deviceToken = TokenVault(this).get() ?: return
        Api.updatePushToken(deviceToken, token)
    }
}
