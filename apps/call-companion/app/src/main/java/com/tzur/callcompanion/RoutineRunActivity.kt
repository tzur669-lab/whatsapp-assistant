package com.tzur.callcompanion

import android.app.Activity
import android.app.KeyguardManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView

/**
 * Brings the screen on over the lock screen for a scheduled routine (0.13,
 * PLAN §6.27) and asks Android to dismiss the lock. No app can unlock a phone:
 * with Extend Unlock holding it open the lock goes by itself, and with a
 * secure lock Android asks for the fingerprint. Only once the lock is gone is
 * the run claimed and started; if it stays locked, the run is reported as
 * locked and nothing runs.
 */
class RoutineRunActivity : Activity() {

    private var done = false
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A screen task (0.14) waits for the unlock the same way, then is claimed by its own runner.
        screenTaskId = intent.getStringExtra(EXTRA_SCREEN_TASK_ID)
        val runId = screenTaskId ?: intent.getStringExtra(EXTRA_RUN_ID)
        if (runId == null) {
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(TextView(this).apply {
            text = getString(if (screenTaskId != null) R.string.screen_unlock_prompt else R.string.routine_unlock_prompt)
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        })

        // Nobody answered the lock screen: the run is reported, never left waiting.
        main.postDelayed({ settle(runId, unlocked = false) }, UNLOCK_WAIT_MS)

        val keyguard = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        if (!keyguard.isKeyguardLocked) {
            settle(runId, unlocked = true)
            return
        }
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = settle(runId, unlocked = true)
            override fun onDismissCancelled() = settle(runId, unlocked = false)
            override fun onDismissError() = settle(runId, unlocked = false)
        })
    }

    private fun settle(runId: String, unlocked: Boolean) {
        if (done) return
        done = true
        main.removeCallbacksAndMessages(null)
        val app = applicationContext
        val screen = screenTaskId != null
        when {
            screen && unlocked -> ScreenAgentRunner.start(app, runId)
            screen -> ScreenAgentRunner.lockedOut(app, runId)
            unlocked -> Thread { RoutineRunner.claimAndRun(app, runId) }.start()
            else -> RoutineRunner.lockedOut(app, runId)
        }
        finish()
    }

    private var screenTaskId: String? = null

    companion object {
        const val EXTRA_RUN_ID = "routine_run_id"
        /** Set instead of [EXTRA_RUN_ID] for a screen task: after the unlock, the screen runner claims it. */
        const val EXTRA_SCREEN_TASK_ID = "screen_task_id"
        /** Two minutes for a finger on the sensor, well inside the run's ten. */
        private const val UNLOCK_WAIT_MS = 2 * 60_000L
    }
}
