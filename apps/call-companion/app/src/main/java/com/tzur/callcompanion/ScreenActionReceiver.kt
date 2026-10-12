package com.tzur.callcompanion

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * The screen agent's notification buttons (0.14). Not exported: only the
 * app's own immutable PendingIntents reach it.
 * - "עצור" stops the running task at once (the runner reports `stopped_user`);
 * - "אשר" / "דחה" send the signed `/app/screen/approve`, the same decision as
 *   the chat card's; the first decision wins on the server. On Android 12+
 *   Android asks for the unlock before the tap gets here.
 */
class ScreenActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(ScreenNotifications.EXTRA_TASK_ID) ?: return
        if (!ScreenLogic.ID.matches(taskId)) return
        val app = context.applicationContext
        val pending = goAsync()
        // Off the main thread: a stop aborts a request in flight, and a verdict is a request.
        Thread {
            try {
                when (intent.action) {
                    ScreenNotifications.ACTION_STOP -> ScreenAgentRunner.stop(taskId, ScreenAgentRunner.StopBy.USER)
                    ScreenNotifications.ACTION_APPROVE -> ScreenVerdict.send(app, intent, approve = true)
                    ScreenNotifications.ACTION_REJECT -> ScreenVerdict.send(app, intent, approve = false)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }
}

/** Before Android 12 the approval buttons open this (after the unlock): it sends the verdict and closes. */
class ScreenApproveActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        val copy = Intent(intent)
        val approve = intent.action == ScreenNotifications.ACTION_APPROVE
        if (intent.action == ScreenNotifications.ACTION_APPROVE || intent.action == ScreenNotifications.ACTION_REJECT) {
            Thread { ScreenVerdict.send(app, copy, approve) }.start()
        }
        finish()
    }
}

internal object ScreenVerdict {
    private val main = Handler(Looper.getMainLooper())

    /** Blocks on the network. The approval wait is woken whatever the answer, to read the task's state now. */
    fun send(context: Context, intent: Intent, approve: Boolean) {
        val taskId = intent.getStringExtra(ScreenNotifications.EXTRA_TASK_ID) ?: return
        val actionId = intent.getStringExtra(ScreenNotifications.EXTRA_ACTION_ID) ?: return
        val nonce = intent.getStringExtra(ScreenNotifications.EXTRA_NONCE) ?: return
        if (!ScreenLogic.ID.matches(taskId) || !ScreenLogic.ID.matches(actionId) || !ScreenLogic.ID.matches(nonce)) return
        val status = Api.approveScreen(context, taskId, actionId, nonce, approve)
        val message = when (status) {
            null -> R.string.screen_verdict_failed
            "already" -> R.string.screen_verdict_already
            else -> R.string.screen_verdict_sent
        }
        // A failed send keeps the notification, so the user can try again.
        if (status != null) ScreenNotifications.cancelApproval(context, actionId)
        ScreenAgentRunner.wake(taskId)
        main.post { Toast.makeText(context, message, Toast.LENGTH_SHORT).show() }
    }
}
