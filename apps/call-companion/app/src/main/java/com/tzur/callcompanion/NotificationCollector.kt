package com.tzur.callcompanion

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Writes the phone's notifications into [NotificationBuffer], so the assistant
 * can answer "what did I get" (PLAN §6.21). Runs only after the user grants
 * notification access in the system settings, and stops when it is revoked.
 *
 * It never acts on a notification — never opens, replies to or dismisses one —
 * and nothing it reads leaves the phone until a phone read asks for it.
 */
class NotificationCollector : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            collect(sbn)
        } catch (_: Exception) {
            // A malformed notification from another app must not take this service down.
        }
    }

    private fun collect(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName || sbn.isOngoing) return
        val notification = sbn.notification ?: return
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (notification.category in SKIPPED_CATEGORIES) return
        if (notification.visibility == Notification.VISIBILITY_SECRET) return
        if (sbn.packageName in NotificationBuffer.hidden(this)) return

        val extras = notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.takeIf { it.isNotBlank() }
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))
            ?.toString()?.takeIf { it.isNotBlank() }
        if (title == null && text == null) return
        if (PhoneReadLogic.looksLikeOtp("${title.orEmpty()} ${text.orEmpty()}")) return

        val app = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            sbn.packageName
        }
        NotificationBuffer.get(this).add(sbn.key, sbn.packageName, app, title, text, sbn.postTime)
    }

    private companion object {
        /** Calls, progress bars, media and the system's own status: not things anyone "got". */
        val SKIPPED_CATEGORIES = setOf(
            Notification.CATEGORY_CALL,
            Notification.CATEGORY_PROGRESS,
            Notification.CATEGORY_SERVICE,
            Notification.CATEGORY_TRANSPORT,
            Notification.CATEGORY_SYSTEM,
            Notification.CATEGORY_STATUS,
        )
    }
}
