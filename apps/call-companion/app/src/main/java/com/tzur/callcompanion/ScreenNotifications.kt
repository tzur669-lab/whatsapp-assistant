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
 * The screen agent's notifications (0.14, plan §3, §5, §9.3–9.4):
 * - while a task runs, an ongoing one with "עצור";
 * - before an uncertain or sensitive action, one high-priority approval per
 *   action id, built here from the full node: the app, the action, the
 *   target's own label, why it asks, and an input only as "קלט 1". Private on
 *   the lock screen; on Android 12+ its buttons need the phone unlocked
 *   (`setAuthenticationRequired`), and on older versions they open the app.
 * Cancelled on any outcome.
 * - after a clean finish (phase 3), "save as a routine?" or "can't be saved".
 */
object ScreenNotifications {
    private const val CHANNEL_APPROVAL = "screen_approval"
    private const val CHANNEL_RUNNING = "screen_running"
    private const val TAG_APPROVAL = "screen"
    private const val TAG_RUNNING = "screen_run"
    private const val RUNNING_ID = 1
    private const val CHANNEL_DRAFT = "routine_draft"
    private const val TAG_DRAFT = "routine_draft"
    /** One draft at a time, so one notification: a newer one replaces it. */
    private const val DRAFT_ID = 1

    const val ACTION_APPROVE = "com.tzur.callcompanion.SCREEN_APPROVE"
    const val ACTION_REJECT = "com.tzur.callcompanion.SCREEN_REJECT"
    const val ACTION_STOP = "com.tzur.callcompanion.SCREEN_STOP"
    const val EXTRA_TASK_ID = "screen_task_id"
    const val EXTRA_ACTION_ID = "screen_action_id"
    const val EXTRA_NONCE = "screen_nonce"

    private val shown = HashSet<String>()

    private fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_APPROVAL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_APPROVAL, context.getString(R.string.channel_screen), NotificationManager.IMPORTANCE_HIGH),
            )
        }
        if (manager.getNotificationChannel(CHANNEL_RUNNING) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_RUNNING, context.getString(R.string.channel_screen_running), NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    fun showRunning(context: Context, taskId: String, appLabel: String) {
        if (!canNotify(context)) return
        ensureChannels(context)
        val stop = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, ScreenActionReceiver::class.java)
                .setAction(ACTION_STOP)
                .setData(Uri.parse("assistant-screen://stop/$taskId"))
                .putExtra(EXTRA_TASK_ID, taskId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.screen_running_title, Ui.isolate(appLabel)))
            .setContentText(context.getString(R.string.screen_running_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(Notification.Action.Builder(null, context.getString(R.string.screen_stop), stop).build())
            .build()
        context.getSystemService(NotificationManager::class.java).notify(TAG_RUNNING, RUNNING_ID, notification)
    }

    fun cancelRunning(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(TAG_RUNNING, RUNNING_ID)
    }

    /**
     * The approval for one action, at most once per [actionId]. [what] is the
     * action line ("לחיצה על …"), [why] the reason line; both built by the runner.
     */
    fun showApproval(
        context: Context,
        taskId: String,
        actionId: String,
        nonce: String,
        appLabel: String,
        what: String,
        why: String,
    ) {
        if (!canNotify(context)) return
        synchronized(shown) { if (!shown.add(actionId)) return }
        ensureChannels(context)
        val text = "$what\n$why"
        val builder = Notification.Builder(context, CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.screen_approval_title, Ui.isolate(appLabel)))
            .setContentText(what)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notification.Builder(context, CHANNEL_APPROVAL)
                    .setSmallIcon(R.drawable.ic_assistant)
                    .setContentTitle(context.getString(R.string.screen_approval_public))
                    .build(),
            )
            .setContentIntent(openChat(context))
            .setAutoCancel(false)
        builder.addAction(verdict(context, taskId, actionId, nonce, approve = true))
        builder.addAction(verdict(context, taskId, actionId, nonce, approve = false))
        context.getSystemService(NotificationManager::class.java).notify(TAG_APPROVAL, idOf(actionId), builder.build())
    }

    fun cancelApproval(context: Context, actionId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(TAG_APPROVAL, idOf(actionId))
    }

    private fun verdict(context: Context, taskId: String, actionId: String, nonce: String, approve: Boolean): Notification.Action {
        val title = context.getString(if (approve) R.string.screen_approve else R.string.screen_reject)
        val action = if (approve) ACTION_APPROVE else ACTION_REJECT
        val data = Uri.parse("assistant-screen://${if (approve) "yes" else "no"}/$actionId")
        val pending = if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.getBroadcast(
                context,
                0,
                Intent(context, ScreenActionReceiver::class.java).setAction(action).setData(data)
                    .putExtra(EXTRA_TASK_ID, taskId).putExtra(EXTRA_ACTION_ID, actionId).putExtra(EXTRA_NONCE, nonce),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        } else {
            // No authentication on actions before Android 12: the button opens the app,
            // which on a locked phone asks for the unlock first.
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, ScreenApproveActivity::class.java).setAction(action).setData(data)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(EXTRA_TASK_ID, taskId).putExtra(EXTRA_ACTION_ID, actionId).putExtra(EXTRA_NONCE, nonce),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val builder = Notification.Action.Builder(null, title, pending)
        if (Build.VERSION.SDK_INT >= 31) builder.setAuthenticationRequired(true)
        return builder.build()
    }

    // -- phase 3: a routine draft (plan routine-from-screen-task.md, "The user's flow") --

    /**
     * "Save as a routine?" for the draft [draftId]: opens the routines screen
     * in review mode. Private on the lock screen: no step text, no app name.
     */
    fun showDraft(context: Context, draftId: String, appLabel: String) {
        if (!canNotify(context)) return
        ensureDraftChannel(context)
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, RoutinesActivity::class.java)
                .setData(Uri.parse("assistant-routine-draft://review/$draftId"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(RoutinesActivity.EXTRA_DRAFT_ID, draftId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_DRAFT)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.draft_notify_title))
            .setContentText(context.getString(R.string.draft_notify_text, Ui.isolate(appLabel)))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(draftPublic(context))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(RoutineDrafts.TTL_MS)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(TAG_DRAFT, DRAFT_ID, notification)
    }

    /** A clean finish that cannot become a routine: one fixed sentence per [reason], no button. */
    fun showDraftSpoiled(context: Context, appLabel: String, reason: String) {
        if (!canNotify(context)) return
        ensureDraftChannel(context)
        val why = context.getString(RoutineRecording.spoiledText(reason))
        val notification = Notification.Builder(context, CHANNEL_DRAFT)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.draft_spoiled_title, Ui.isolate(appLabel)))
            .setContentText(why)
            .setStyle(Notification.BigTextStyle().bigText(why))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(draftPublic(context))
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(TAG_DRAFT, DRAFT_ID, notification)
    }

    /** The draft is saved or discarded: its notification goes too. */
    fun cancelDraft(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(TAG_DRAFT, DRAFT_ID)
    }

    private fun draftPublic(context: Context): Notification =
        Notification.Builder(context, CHANNEL_DRAFT)
            .setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle(context.getString(R.string.draft_notify_public))
            .build()

    private fun ensureDraftChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_DRAFT) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_DRAFT, context.getString(R.string.channel_routine_draft), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    private fun openChat(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, ChatActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun idOf(actionId: String): Int = actionId.hashCode()

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}
