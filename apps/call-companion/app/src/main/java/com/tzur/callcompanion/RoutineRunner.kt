package com.tzur.callcompanion

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A scheduled routine run, from the push to the report (0.13, PLAN §6.27).
 *
 * 1. FCM wakes the app with the run's opaque id.
 * 2. A locked phone is unlocked first (`RoutineRunActivity`): with Extend
 *    Unlock on, by itself; with a secure lock, by one fingerprint touch. Only
 *    then the claim, so a run is never claimed and left waiting on a finger.
 * 3. The signed claim, once: the server says which routine, and its step hash.
 *    A routine missing here, or with other steps, is not run ("changed").
 * 4. The accessibility service runs the steps; the outcome goes back as codes.
 *
 * Nothing is retried after the claim: a second run of a punch is worse than
 * none. A report that cannot be sent waits here and goes with the next sync.
 */
object RoutineRunner {
    private const val PREFS = "routine_reports"
    private const val KEY = "pending"
    private const val REPORT_ATTEMPTS = 3
    private const val CLAIM_ATTEMPTS = 2

    private val synced = AtomicBoolean(false)

    /** Reasons the server knows; anything else is reported as `error`. */
    private val REASONS = setOf(
        "locked", "app_missing", "app_not_front", "launch_confirm", "app_left", "text_not_found",
        "not_verified", "target_not_found", "target_disabled", "target_ambiguous", "tap_refused",
        "deadline", "changed", "service_off", "error",
    )

    /** From the push, on FCM's thread. */
    fun onPush(context: Context, runId: String) {
        if (!RUN_ID.matches(runId)) return
        val app = context.applicationContext
        if (!RoutineAccessibilityService.isOn) {
            report(app, runId, "blocked", "service_off")
            return
        }
        val keyguard = app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (keyguard.isKeyguardLocked) {
            // The screen comes on over the lock screen; the run waits for the unlock.
            app.startActivity(
                Intent(app, RoutineRunActivity::class.java)
                    .putExtra(RoutineRunActivity.EXTRA_RUN_ID, runId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
            return
        }
        claimAndRun(app, runId)
    }

    /** After the unlock (or with the phone already open). Blocks on the network: never the main thread. */
    fun claimAndRun(context: Context, runId: String) {
        var claim: Api.RoutineClaim = Api.RoutineClaim.Unreachable
        for (attempt in 1..CLAIM_ATTEMPTS) {
            claim = Api.claimRoutine(context, runId)
            if (claim !is Api.RoutineClaim.Unreachable) break
        }
        // Refused (cancelled, late, already claimed, changed) or unreachable: the
        // server tells the user; nothing runs.
        val ok = claim as? Api.RoutineClaim.Ok ?: return

        val routine = RoutineStore.get(context, ok.routineId)
        if (routine == null || RoutineLogic.stepHash(routine) != ok.stepHash) {
            report(context, runId, "changed", "changed")
            return
        }
        val started = RoutineAccessibilityService.run(routine, dryRun = false) { result ->
            report(context, runId, wireOutcome(result.outcome), result.reason.ifEmpty { null })
        }
        if (!started) report(context, runId, "failed_before_tap", "service_off")
    }

    /** The phone stayed locked: nothing was claimed, nothing ran. */
    fun lockedOut(context: Context, runId: String) {
        report(context.applicationContext, runId, "blocked", "locked")
    }

    /** Sends the outcome on a background thread; kept for the next sync if the server cannot be reached. */
    fun report(context: Context, runId: String, outcome: String, reason: String?) {
        val app = context.applicationContext
        val safeReason = reason?.let { if (it in REASONS) it else "error" }
        Thread {
            for (attempt in 1..REPORT_ATTEMPTS) {
                if (Api.reportRoutine(app, runId, outcome, safeReason)) return@Thread
                Thread.sleep(2_000L * attempt)
            }
            keep(app, runId, outcome, safeReason)
        }.start()
    }

    /** The server's copy of the routines: after every change. */
    fun sync(context: Context) {
        val app = context.applicationContext
        if (!Signer(app).isPaired) return
        Thread { Api.syncRoutines(app, RoutineStore.all(app)) }.start()
    }

    /** Once per process, from the chat: the names, and any report that waited. */
    fun syncOnce(context: Context) {
        if (!synced.compareAndSet(false, true)) return
        val app = context.applicationContext
        if (!Signer(app).isPaired) return
        Thread {
            Api.syncRoutines(app, RoutineStore.all(app))
            flush(app)
        }.start()
    }

    private fun wireOutcome(outcome: RoutineLogic.Outcome): String = when (outcome) {
        RoutineLogic.Outcome.VERIFIED -> "verified"
        RoutineLogic.Outcome.TAPPED_UNVERIFIED -> "tapped_unverified"
        RoutineLogic.Outcome.FAILED_BEFORE_TAP, RoutineLogic.Outcome.DRY_RUN_OK -> "failed_before_tap"
        RoutineLogic.Outcome.FAILED_AFTER_TAP -> "failed_after_tap"
        RoutineLogic.Outcome.BLOCKED -> "blocked"
    }

    private fun keep(context: Context, runId: String, outcome: String, reason: String?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = try { JSONArray(prefs.getString(KEY, "[]")) } catch (_: Exception) { JSONArray() }
        list.put(JSONObject().put("runId", runId).put("outcome", outcome).apply { if (reason != null) put("reason", reason) })
        prefs.edit().putString(KEY, list.toString()).apply()
    }

    private fun flush(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = try { JSONArray(prefs.getString(KEY, "[]")) } catch (_: Exception) { JSONArray() }
        if (list.length() == 0) return
        val left = JSONArray()
        for (i in 0 until list.length()) {
            val item = list.optJSONObject(i) ?: continue
            val reason = if (item.has("reason")) item.optString("reason") else null
            if (!Api.reportRoutine(context, item.optString("runId"), item.optString("outcome"), reason)) left.put(item)
        }
        prefs.edit().putString(KEY, left.toString()).apply()
    }

    private val RUN_ID = Regex("^[0-9a-f]{32}$")
}
