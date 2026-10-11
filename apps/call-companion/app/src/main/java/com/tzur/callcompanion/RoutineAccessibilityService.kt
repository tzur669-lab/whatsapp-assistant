package com.tzur.callcompanion

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.Executors

/**
 * Runs a routine's steps inside one other app (0.13, PLAN §6.27). The user
 * turns it on in the system's accessibility settings; until then nothing runs.
 *
 * What it may do, checked again before every step (not only by the
 * `packageNames` filter, which limits the events it hears and nothing else):
 * - the phone is not locked — it never touches the lock screen;
 * - the active window belongs to the routine's own app;
 * - a tap is `ACTION_CLICK` on the one element [RoutineLogic.pickTarget]
 *   chose, re-read just before the click. No coordinates, no typing, no
 *   scrolling, no global actions.
 * Screen content is read only to match the routine's own words. It is never
 * stored, logged or sent anywhere; a result carries codes only.
 *
 * Runs go one at a time on one thread: a second waits for the first.
 */
class RoutineAccessibilityService : AccessibilityService() {

    /** The package of the run in progress, and the last time its screen changed. */
    @Volatile private var runningPackage: String? = null
    @Volatile private var lastChangeAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        applyPackages(emptyList())
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val running = runningPackage ?: return
        if (event?.packageName?.toString() == running) lastChangeAt = SystemClock.uptimeMillis()
    }

    /** Hear only the apps the saved routines use, plus [extra]; with none, only this app. */
    private fun applyPackages(extra: List<String>) {
        val packages = (RoutineStore.all(this).map { it.packageName } + extra).distinct()
        val info = serviceInfo ?: return
        info.packageNames = packages.ifEmpty { listOf(packageName) }.toTypedArray()
        serviceInfo = info
    }

    private fun start(routine: RoutineLogic.Routine, dryRun: Boolean, done: (RoutineLogic.Result) -> Unit) {
        applyPackages(listOf(routine.packageName))
        worker.execute {
            val result = try {
                execute(routine, dryRun)
            } catch (_: Exception) {
                // An Android error mid-run; whether a tap happened is unknown to the caller.
                RoutineLogic.Result(RoutineLogic.Outcome.FAILED_AFTER_TAP, -1, "error")
            } finally {
                runningPackage = null
            }
            main.post { done(result) }
        }
    }

    /**
     * Opens [packageName], waits for its screen to settle, and lists what a
     * routine could use there. Taps nothing; the list stays on this phone.
     * Null when the app did not come to the front, or the phone is locked.
     */
    private fun startScan(packageName: String, done: (List<RoutineLogic.ScanLine>?) -> Unit) {
        applyPackages(listOf(packageName))
        worker.execute {
            val lines = try {
                scanNow(packageName)
            } catch (_: Exception) {
                null
            } finally {
                runningPackage = null
            }
            main.post { done(lines) }
        }
    }

    private fun scanNow(packageName: String): List<RoutineLogic.ScanLine>? {
        if (locked()) return null
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        val deadline = SystemClock.uptimeMillis() + RoutineLogic.OPEN_TIMEOUT_MS + SCAN_SETTLE_MS
        runningPackage = packageName
        lastChangeAt = SystemClock.uptimeMillis()
        main.post { startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        if (!waitFor(RoutineLogic.OPEN_TIMEOUT_MS, deadline) { snapshot(packageName) != null }) return null
        // A web page inside the app keeps loading after its window appears.
        SystemClock.sleep(SCAN_SETTLE_MS)
        waitUntilStable(deadline + RoutineLogic.STABLE_MAX_MS)
        val (_, infos) = snapshot(packageName) ?: return null
        return RoutineLogic.scan(infos)
    }

    private fun execute(routine: RoutineLogic.Routine, dryRun: Boolean): RoutineLogic.Result {
        val deadline = SystemClock.uptimeMillis() + RoutineLogic.RUN_DEADLINE_MS
        if (locked()) return RoutineLogic.Result(RoutineLogic.Outcome.BLOCKED, -1, "locked")

        val launch = packageManager.getLaunchIntentForPackage(routine.packageName)
            ?: return RoutineLogic.failure(0, -1, "app_missing")
        runningPackage = routine.packageName
        lastChangeAt = SystemClock.uptimeMillis()
        main.post { startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        if (!waitFor(RoutineLogic.OPEN_TIMEOUT_MS, deadline) { snapshot(routine.packageName) != null }) {
            return RoutineLogic.failure(0, -1, if (locked()) "locked" else "app_not_front")
        }

        var tapped = 0
        routine.steps.forEachIndexed { index, step ->
            if (SystemClock.uptimeMillis() > deadline) return RoutineLogic.failure(tapped, index, "deadline")
            if (locked()) return RoutineLogic.failure(tapped, index, "locked")
            when (step.kind) {
                RoutineLogic.Kind.WAIT -> SystemClock.sleep(step.seconds * 1000L)

                RoutineLogic.Kind.WAIT_FOR_TEXT -> {
                    val seen = waitFor(step.seconds * 1000L, deadline) {
                        snapshot(routine.packageName)?.let { RoutineLogic.hasText(it.second, step.value) } == true
                    }
                    if (!seen) return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "text_not_found")
                }

                RoutineLogic.Kind.EXPECT_TEXT -> {
                    val seen = waitFor(step.seconds * 1000L, deadline) {
                        snapshot(routine.packageName)?.let { RoutineLogic.hasText(it.second, step.value) } == true
                    }
                    if (!seen) return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "not_verified")
                }

                RoutineLogic.Kind.EXPECT_DISABLED -> {
                    val off = waitFor(step.seconds * 1000L, deadline) {
                        snapshot(routine.packageName)?.let { RoutineLogic.isDisabled(it.second, step.value) } == true
                    }
                    if (!off) return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "not_verified")
                }

                RoutineLogic.Kind.TAP_TEXT, RoutineLogic.Kind.TAP_ID -> {
                    waitUntilStable(deadline)
                    val (nodes, infos) = snapshot(routine.packageName)
                        ?: return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "app_not_front")
                    when (val pick = RoutineLogic.pickTarget(infos, step)) {
                        RoutineLogic.Pick.None -> return RoutineLogic.failure(tapped, index, "target_not_found")
                        RoutineLogic.Pick.Disabled -> return RoutineLogic.failure(tapped, index, "target_disabled")
                        is RoutineLogic.Pick.Many -> return RoutineLogic.failure(tapped, index, "target_ambiguous")
                        is RoutineLogic.Pick.One -> {
                            // A dry run stops at the first tap: everything before it was found.
                            if (dryRun) return RoutineLogic.Result(RoutineLogic.Outcome.DRY_RUN_OK, index)
                            if (!click(nodes[pick.index], routine.packageName)) {
                                return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "tap_refused")
                            }
                            tapped++
                            lastChangeAt = SystemClock.uptimeMillis()
                        }
                    }
                }
            }
        }
        if (dryRun) return RoutineLogic.Result(RoutineLogic.Outcome.DRY_RUN_OK, routine.steps.size)
        return RoutineLogic.Result(
            if (routine.verifies) RoutineLogic.Outcome.VERIFIED else RoutineLogic.Outcome.TAPPED_UNVERIFIED,
        )
    }

    /** The click, after the last checks: still unlocked, still the routine's app, still usable. */
    private fun click(node: AccessibilityNodeInfo, packageName: String): Boolean {
        if (locked()) return false
        if (!node.refresh()) return false
        if (node.packageName?.toString() != packageName) return false
        if (!node.isVisibleToUser || !node.isEnabled) return false
        if (rootInActiveWindow?.packageName?.toString() != packageName) return false
        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    /** Why the guard would refuse now, or null if it would not. */
    private fun guardReason(routine: RoutineLogic.Routine): String? = when {
        locked() -> "locked"
        rootInActiveWindow?.packageName?.toString() != routine.packageName -> "app_left"
        else -> null
    }

    private fun locked(): Boolean =
        (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

    /**
     * The active window flattened, only when it is [packageName]'s and the
     * phone is unlocked; else null. Each element's tap target is itself when
     * clickable, else its nearest clickable ancestor.
     */
    private fun snapshot(packageName: String): Pair<List<AccessibilityNodeInfo>, List<RoutineLogic.Node>>? {
        if (locked()) return null
        val root = rootInActiveWindow ?: return null
        if (root.packageName?.toString() != packageName) return null
        val nodes = ArrayList<AccessibilityNodeInfo>()
        val infos = ArrayList<RoutineLogic.Node>()
        val stack = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        stack.addLast(root to -1)
        while (stack.isNotEmpty() && nodes.size < MAX_NODES) {
            val (node, parentTarget) = stack.removeLast()
            val index = nodes.size
            val target = if (node.isClickable) index else parentTarget
            nodes.add(node)
            infos.add(
                RoutineLogic.Node(
                    text = node.text?.toString(),
                    description = node.contentDescription?.toString(),
                    viewId = node.viewIdResourceName,
                    visible = node.isVisibleToUser,
                    enabled = node.isEnabled,
                    target = target,
                    hint = node.hintText?.toString(),
                    editable = node.isEditable,
                    clickable = node.isClickable,
                ),
            )
            for (i in node.childCount - 1 downTo 0) node.getChild(i)?.let { stack.addLast(it to target) }
        }
        return nodes to infos
    }

    private fun waitUntilStable(deadline: Long) {
        val until = minOf(SystemClock.uptimeMillis() + RoutineLogic.STABLE_MAX_MS, deadline)
        while (SystemClock.uptimeMillis() < until) {
            if (SystemClock.uptimeMillis() - lastChangeAt >= RoutineLogic.STABLE_MS) return
            SystemClock.sleep(POLL_MS)
        }
    }

    private inline fun waitFor(timeoutMs: Long, deadline: Long, check: () -> Boolean): Boolean {
        val until = minOf(SystemClock.uptimeMillis() + timeoutMs, deadline)
        while (true) {
            if (check()) return true
            if (SystemClock.uptimeMillis() >= until) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    companion object {
        private const val POLL_MS = 250L
        private const val MAX_NODES = 2_000
        private const val SCAN_SETTLE_MS = 2_000L

        @Volatile private var instance: RoutineAccessibilityService? = null
        private val worker = Executors.newSingleThreadExecutor()
        private val main = Handler(Looper.getMainLooper())

        /** Whether the user has turned the service on (and the system has bound it). */
        val isOn: Boolean get() = instance != null

        /**
         * Starts a run, or returns false when the service is off. [done] is
         * called on the main thread with the result.
         */
        fun run(routine: RoutineLogic.Routine, dryRun: Boolean, done: (RoutineLogic.Result) -> Unit): Boolean {
            val service = instance ?: return false
            service.start(routine, dryRun, done)
            return true
        }

        /** A screen scan of [packageName]; false when the service is off. */
        fun scan(packageName: String, done: (List<RoutineLogic.ScanLine>?) -> Unit): Boolean {
            val service = instance ?: return false
            service.startScan(packageName, done)
            return true
        }

        /** After the routines change: listen to their apps only. */
        fun refreshPackages(@Suppress("UNUSED_PARAMETER") context: Context) {
            val service = instance ?: return
            main.post { service.applyPackages(emptyList()) }
        }
    }
}
