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
import java.lang.ref.WeakReference

/**
 * Brings the screen on over the lock screen for a scheduled routine (0.13,
 * PLAN §6.27) and asks Android to dismiss the lock. With Extend Unlock
 * holding the phone open the lock goes by itself, and with a secure lock
 * Android asks for the fingerprint. Only once the lock is gone is the run
 * started; if it stays locked, the run is reported as locked and nothing runs.
 *
 * Three modes:
 * - **unclaimed** (no stored PIN): after the unlock the run is claimed and run;
 * - **claimed** (0.17, [EXTRA_CLAIMED_ROUTINE]): the runner claimed first; after
 *   the unlock it runs through [RoutineRunner.runClaimed], never a second claim;
 * - **pin** (0.17, [EXTRA_PIN_MODE]): the screen on and the keypad up while the
 *   accessibility service types the stored PIN. It never reports and never
 *   starts anything: [RoutineRunner] owns that run and closes it
 *   ([closePinMode]), or it closes itself after [PIN_MODE_MAX_MS].
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
        val pinMode = screenTaskId == null && intent.getBooleanExtra(EXTRA_PIN_MODE, false)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(TextView(this).apply {
            text = getString(
                when {
                    screenTaskId != null -> R.string.screen_unlock_prompt
                    pinMode -> R.string.routine_unlock_pin_prompt
                    else -> R.string.routine_unlock_prompt
                },
            )
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        })

        val keyguard = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        if (pinMode) {
            pinActivity = WeakReference(this)
            main.postDelayed({ finish() }, PIN_MODE_MAX_MS)
            // The keypad comes up for the service to type on; what happens next is the runner's.
            if (keyguard.isKeyguardLocked) keyguard.requestDismissKeyguard(this, null)
            return
        }
        claimedRoutine = intent.getStringExtra(EXTRA_CLAIMED_ROUTINE)
        claimedHash = intent.getStringExtra(EXTRA_CLAIMED_HASH)

        // Nobody answered the lock screen: the run is reported, never left waiting.
        main.postDelayed({ settle(runId, unlocked = false) }, UNLOCK_WAIT_MS)

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

    override fun onDestroy() {
        if (pinActivity?.get() === this) pinActivity = null
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun settle(runId: String, unlocked: Boolean) {
        if (done) return
        done = true
        main.removeCallbacksAndMessages(null)
        val app = applicationContext
        val screen = screenTaskId != null
        val routineId = claimedRoutine
        val stepHash = claimedHash
        when {
            screen && unlocked -> ScreenAgentRunner.start(app, runId)
            screen -> ScreenAgentRunner.lockedOut(app, runId)
            unlocked && routineId != null && stepHash != null ->
                Thread { RoutineRunner.runClaimed(app, runId, routineId, stepHash) }.start()
            unlocked -> Thread { RoutineRunner.claimAndRun(app, runId) }.start()
            else -> RoutineRunner.lockedOut(app, runId)
        }
        finish()
    }

    private var screenTaskId: String? = null
    private var claimedRoutine: String? = null
    private var claimedHash: String? = null

    companion object {
        const val EXTRA_RUN_ID = "routine_run_id"
        /** Set instead of [EXTRA_RUN_ID] for a screen task: after the unlock, the screen runner claims it. */
        const val EXTRA_SCREEN_TASK_ID = "screen_task_id"
        /** With [EXTRA_CLAIMED_HASH]: the run is claimed already (0.17). */
        const val EXTRA_CLAIMED_ROUTINE = "claimed_routine_id"
        const val EXTRA_CLAIMED_HASH = "claimed_step_hash"
        /** The stored PIN is being typed (0.17): show, wait, never report. */
        const val EXTRA_PIN_MODE = "pin_mode"
        /** Two minutes for a finger on the sensor, well inside the run's ten. */
        private const val UNLOCK_WAIT_MS = 2 * 60_000L
        /** A safety net only: the runner closes the pin mode as soon as its job ends. */
        private const val PIN_MODE_MAX_MS = 60_000L

        @Volatile private var pinActivity: WeakReference<RoutineRunActivity>? = null

        /** The runner's job ended: the pin-mode screen goes away. Any thread. */
        fun closePinMode() {
            val activity = pinActivity?.get() ?: return
            activity.runOnUiThread { activity.finish() }
        }
    }
}
