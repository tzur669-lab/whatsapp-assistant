package com.tzur.callcompanion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * The call request on screen. Android has blocked background activity starts
 * since 10, so a push cannot open a dialer by itself — it posts a high-priority
 * notification with a full-screen intent, and the user's tap is what dials.
 * That tap, on a screen showing the resolved number, is the Tier 3 factor.
 */
object CallNotifier {
    private const val CHANNEL = "call_requests"
    private const val INFO_ID = 1

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH),
        )
    }

    fun show(context: Context, request: CallRequest) {
        if (!canNotify(context)) return
        ensureChannel(context)
        val base = request.dispatchId.hashCode()
        val open = PendingIntent.getActivity(
            context,
            base,
            request.into(Intent(context, ConfirmCallActivity::class.java)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val cancel = PendingIntent.getBroadcast(
            context,
            base + 1,
            request.into(Intent(context, CancelReceiver::class.java)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val single = request.candidates.singleOrNull()
        val title = if (single != null) context.getString(R.string.call_title, single.name) else context.getString(R.string.call_many_title)
        // The number is the fact that decides whether the right person is about to ring.
        val text = if (single != null) ltr(single.number) else context.getString(R.string.call_many_text)

        val publicVersion = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(context.getString(R.string.call_public_title))
            .build()

        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter((request.expiresAt - System.currentTimeMillis()).coerceAtLeast(1_000L))
            .addAction(Notification.Action.Builder(null, context.getString(R.string.action_cancel), cancel).build())

        if (single != null) {
            val dial = PendingIntent.getActivity(
                context,
                base + 2,
                request.into(Intent(context, ConfirmCallActivity::class.java)).putExtra(ConfirmCallActivity.EXTRA_DIAL_INDEX, 0),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(Notification.Action.Builder(null, context.getString(R.string.action_dial), dial).build())
        }

        if (canUseFullScreen(context)) builder.setFullScreenIntent(open, true)

        context.getSystemService(NotificationManager::class.java).notify(base, builder.build())
    }

    fun showNoMatch(context: Context, words: String) =
        info(context, context.getString(R.string.no_match_title), context.getString(R.string.no_match_text, words))

    fun showNeedsContacts(context: Context) = info(
        context,
        context.getString(R.string.no_contacts_permission_title),
        context.getString(R.string.no_contacts_permission_text),
    )

    fun dismiss(context: Context, dispatchId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(dispatchId.hashCode())
    }

    fun canUseFullScreen(context: Context): Boolean =
        Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    private fun info(context: Context, title: String, text: String) {
        if (!canNotify(context)) return
        ensureChannel(context)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000L)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(INFO_ID, notification)
    }

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** A phone number inside Hebrew text keeps its digit order. */
    fun ltr(text: String): String = "⁦$text⁩"
}
