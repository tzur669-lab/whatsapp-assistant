package com.tzur.callcompanion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build

/**
 * The assistant's messages as notifications (PLAN §6.18). A reminder rings on
 * a high-importance channel; everything else is a quieter message.
 *
 * The notification's id is the row's seq, so the same row never shows twice,
 * and the row's buttons (snooze, done, confirm) become its actions. Each
 * action is a broadcast to [ActionReceiver], which is not exported, through
 * an immutable PendingIntent whose data URI is unique per (seq, button) — two
 * actions can never collapse into one, and nothing outside the app can fire
 * them or rewrite what they carry.
 */
object Notifier {
    private const val CHANNEL_REMINDERS = "reminders"
    private const val CHANNEL_MESSAGES = "messages"
    private const val TAG = "row"
    private const val GENERIC_ID = -1
    /** Android shows three actions at most. */
    private const val MAX_ACTIONS = 3

    const val EXTRA_SEQ = "seq"
    const val EXTRA_BUTTON_ID = "button_id"
    const val EXTRA_BUTTON_TITLE = "button_title"

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_REMINDERS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_REMINDERS, context.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH),
            )
        }
        if (manager.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    /** Rows that just arrived. Nothing while the chat is on screen: they are visible there. */
    fun announce(context: Context, rows: List<Row>) {
        if (rows.isEmpty() || ChatEvents.foreground || !canNotify(context)) return
        ensureChannels(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(TAG, GENERIC_ID)
        for (row in rows) manager.notify(TAG, idOf(row.seq), build(context, row))
    }

    /**
     * The push arrived but the fetch did not. A visible notification anyway:
     * the alternative is a reminder that rang silently.
     */
    fun generic(context: Context) {
        if (!canNotify(context)) return
        ensureChannels(context)
        val notification = Notification.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.notif_message_title))
            .setContentText(context.getString(R.string.notif_generic))
            .setContentIntent(openChat(context))
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(TAG, GENERIC_ID, notification)
    }

    fun cancel(context: Context, seq: Long) {
        context.getSystemService(NotificationManager::class.java).cancel(TAG, idOf(seq))
    }

    /** The chat opened: everything it shows is seen. Call requests are not touched. */
    fun cancelAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (active in manager.activeNotifications) {
            if (active.tag == TAG) manager.cancel(TAG, active.id)
        }
    }

    fun areEnabled(context: Context): Boolean =
        canNotify(context) && context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    private fun build(context: Context, row: Row): Notification {
        val channel = if (row.isReminder) CHANNEL_REMINDERS else CHANNEL_MESSAGES
        val title = context.getString(if (row.isReminder) R.string.notif_reminder_title else R.string.notif_message_title)
        val publicTitle = context.getString(if (row.isReminder) R.string.notif_public_reminder else R.string.notif_public_message)

        val builder = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(title)
            .setContentText(row.text)
            .setStyle(Notification.BigTextStyle().bigText(row.text))
            // The time the server wrote it: a reminder that arrives late says when it was due.
            .setWhen(row.createdAt)
            .setShowWhen(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notification.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_assistant)
                    .setContentTitle(publicTitle)
                    .build(),
            )
            .setContentIntent(openChat(context))
            .setAutoCancel(true)
        if (row.isReminder) builder.setCategory(Notification.CATEGORY_REMINDER)

        if (row.seq > 0) {
            row.buttons.take(MAX_ACTIONS).forEachIndexed { index, button ->
                val intent = Intent(context, ActionReceiver::class.java)
                    .setData(Uri.parse("assistant-action://row/${row.seq}/$index"))
                    .putExtra(EXTRA_SEQ, row.seq)
                    .putExtra(EXTRA_BUTTON_ID, button.id)
                    .putExtra(EXTRA_BUTTON_TITLE, button.title)
                val pending = PendingIntent.getBroadcast(
                    context,
                    (row.seq * MAX_ACTIONS + index).toInt(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                builder.addAction(Notification.Action.Builder(null, button.title, pending).build())
            }
        }
        return builder.build()
    }

    private fun openChat(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, ChatActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Seq is positive and grows by one per row; an int is years of headroom. */
    private fun idOf(seq: Long): Int = (seq % Int.MAX_VALUE).toInt()

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}
