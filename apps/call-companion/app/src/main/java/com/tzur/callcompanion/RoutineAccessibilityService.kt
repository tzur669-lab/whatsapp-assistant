package com.tzur.callcompanion

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Acts inside one other app at a time, for two callers. The user turns it on
 * in the system's accessibility settings; until then nothing runs.
 *
 * **Routines** (0.13, PLAN §6.27): the user's own fixed steps. Checked again
 * before every step (not only by the `packageNames` filter, which limits the
 * events it hears and nothing else):
 * - the phone is not locked — a routine's steps never act on the lock screen;
 * - the active window belongs to the routine's own app;
 * - a tap is `ACTION_CLICK` on the one element [RoutineLogic.pickTarget]
 *   chose, re-read just before the click;
 * - typing (0.13.1) sets only the text written into the routine, on the one
 *   field [RoutineLogic.pickField] chose — never a password field — and the
 *   keyboard's Enter goes only to the focused field.
 * A routine opens its app fresh (`FLAG_ACTIVITY_CLEAR_TASK`), never scrolls
 * and uses no global action. Its screen content is read only to match the
 * routine's own words, and never leaves the phone.
 *
 * **Screen tasks** (0.14, `docs/plans/screen-agent.md`), only through
 * [ScreenOps], driven by [ScreenAgentRunner]:
 * - only in a package on the user's allowlist ([ScreenAllowStore]), opened
 *   without clearing its task, so the user's place in it survives;
 * - the screen is read as [RoutineLogic.Node]s and sent, signed, to the bot's
 *   own server as [ScreenLogic.elements];
 * - every action names its node by the phone's own binding
 *   ([ScreenLogic.binding]): a fresh snapshot must hold exactly one node with
 *   it, and the same last checks as a routine's tap or typing must pass, or
 *   nothing is done;
 * - a tap is [click], typing is [type] with an input the user approved in the
 *   chat, Enter is [submit], a scroll is `ACTION_SCROLL_FORWARD`/`_BACKWARD`
 *   on the bound node, and back is `GLOBAL_ACTION_BACK` — after which the
 *   window must still be the task's app, else the task ends (`left_app`).
 *   No coordinates, no gestures, no other global action.
 *
 * **Unlocking with the stored PIN** (0.17, `docs/plans/routine-auto-unlock.md`),
 * only through [unlockAndRun], only for a claimed routine the user opted in:
 * every digit is matched to exactly one key of the lock screen's keypad by
 * what the key says, before anything is pressed; a key is `ACTION_CLICK`, or,
 * only if Android refuses that, a tap at the key's centre. To raise the
 * keypad it swipes up the lock screen (at most twice; ColorOS ignores the
 * system's dismiss request). Those two are the app's only gestures. Afterwards `GLOBAL_ACTION_LOCK_SCREEN` locks
 * the phone again — the one other global action — when that job typed the
 * PIN and no other job waits. One attempt: see [UnlockStore].
 *
 * Nothing here logs node text; failures are codes.
 *
 * Routines, scans and screen tasks run one at a time on one thread
 * ([worker]): they never act at once, and a second waits for the first.
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

    /**
     * Hear only the apps the saved routines use and the screen agent's
     * allowlist, plus [extra]; with none, only this app.
     */
    private fun applyPackages(extra: List<String>) {
        val packages = (
            RoutineStore.all(this).map { it.packageName } +
                ScreenAllowStore.all(this).map { it.packageName } +
                extra
            ).distinct()
        val info = serviceInfo ?: return
        // Plus the phone's "allow opening another app?" dialog, so a run can tell it is waiting there.
        info.packageNames = packages.ifEmpty { listOf(packageName) }
            .let { if (packages.isEmpty()) it else it + RoutineLogic.LAUNCH_CONFIRM_PACKAGES }
            .toTypedArray()
        serviceInfo = info
    }

    private fun start(routine: RoutineLogic.Routine, dryRun: Boolean, done: (RoutineLogic.Result) -> Unit) {
        applyPackages(listOf(routine.packageName))
        submit {
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
        submit {
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
        val deadline = SystemClock.uptimeMillis() + RoutineLogic.CONFIRM_WAIT_MS + SCAN_SETTLE_MS
        runningPackage = packageName
        if (open(packageName, launch, deadline, fresh = true) != null) return null
        // A web page inside the app keeps loading after its window appears.
        SystemClock.sleep(SCAN_SETTLE_MS)
        waitUntilStable(deadline + RoutineLogic.STABLE_MAX_MS)
        val (_, infos) = snapshot(packageName) ?: return null
        return RoutineLogic.scan(infos)
    }

    /**
     * One job: unlock with [pin] if the phone is still locked, run [routine],
     * then lock again if this job typed the PIN and nothing else waits.
     * [pin] is zeroed here. [done] gets the unlock's code and, when it ran,
     * the routine's result, on the main thread.
     */
    private fun startUnlockAndRun(routine: RoutineLogic.Routine, pin: CharArray, done: (String, RoutineLogic.Result?) -> Unit) {
        submit {
            var code = UNLOCK_NO_KEYPAD
            var result: RoutineLogic.Result? = null
            try {
                code = try { unlockNow(pin) } finally { pin.fill('0') }
                if (code == UNLOCK_OPEN || code == UNLOCK_TYPED) {
                    applyPackages(listOf(routine.packageName))
                    result = try {
                        execute(routine, dryRun = false)
                    } catch (_: Exception) {
                        // An Android error mid-run; whether a tap happened is unknown.
                        RoutineLogic.Result(RoutineLogic.Outcome.FAILED_AFTER_TAP, -1, "error")
                    }
                }
            } catch (_: Exception) {
                // Failed before the run: reported as locked; a started attempt is already in the store.
            } finally {
                runningPackage = null
                if (code == UNLOCK_TYPED && pending.get() == 1) relock()
                applyPackages(emptyList())
            }
            val unlock = code
            main.post { done(unlock, result) }
        }
    }

    /**
     * Types [pin] on the lock screen's keypad, once. [UNLOCK_OPEN] when the
     * phone was already open (nothing typed), [UNLOCK_TYPED] when it opened,
     * [UNLOCK_NO_KEYPAD] when no keypad held one key per digit (nothing
     * typed), [UNLOCK_STILL_LOCKED] when it stayed locked after the PIN.
     */
    private fun unlockNow(pin: CharArray): String {
        if (!locked()) return UNLOCK_OPEN
        applyPackages(listOf(SYSTEM_UI))
        val start = SystemClock.uptimeMillis()
        val until = start + KEYPAD_WAIT_MS
        var swipes = 0
        var nodes: List<AccessibilityNodeInfo>
        var plan: List<Int>?
        var enter: Int?
        while (true) {
            if (!locked()) return UNLOCK_OPEN
            val (infos, keys) = keypad()
            plan = UnlockLogic.plan(pin, keys)
            if (plan != null) {
                nodes = infos
                enter = UnlockLogic.enterKey(keys)
                break
            }
            val now = SystemClock.uptimeMillis()
            if (now >= until) return UNLOCK_NO_KEYPAD
            // The keypad is behind the lock screen's swipe: Android's own dismiss
            // request does not raise it on ColorOS (0.17.1, found on the phone).
            if (swipes < MAX_SWIPES && now - start >= SWIPE_AFTER_MS[swipes]) {
                swipeUp()
                swipes++
            }
            SystemClock.sleep(POLL_MS)
        }
        if (!UnlockStore.beginAttempt(this)) return UNLOCK_NO_KEYPAD
        for (index in plan!!) {
            press(nodes[index])
            SystemClock.sleep(KEY_GAP_MS)
        }
        // A keypad that confirms by itself is open already, and has no Enter.
        if (locked()) enter?.let { press(nodes[it]) }
        val opened = waitFor(OPEN_WAIT_MS, Long.MAX_VALUE) { !locked() }
        return if (opened) {
            UnlockStore.attemptWorked(this)
            UNLOCK_TYPED
        } else {
            UnlockStore.attemptFailed(this)
            UNLOCK_STILL_LOCKED
        }
    }

    /** The system UI's windows (the lock screen and its keypad), flattened. */
    private fun keypad(): Pair<List<AccessibilityNodeInfo>, List<UnlockLogic.Key>> {
        val infos = ArrayList<AccessibilityNodeInfo>()
        val keys = ArrayList<UnlockLogic.Key>()
        for (window in windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != SYSTEM_UI) continue
            val stack = ArrayDeque<AccessibilityNodeInfo>()
            stack.addLast(root)
            while (stack.isNotEmpty() && infos.size < MAX_NODES) {
                val node = stack.removeLast()
                infos.add(node)
                keys.add(
                    UnlockLogic.Key(
                        text = node.text?.toString(),
                        description = node.contentDescription?.toString(),
                        viewId = node.viewIdResourceName,
                        visible = node.isVisibleToUser,
                        enabled = node.isEnabled,
                        clickable = node.isClickable,
                    ),
                )
                for (i in node.childCount - 1 downTo 0) node.getChild(i)?.let { stack.addLast(it) }
            }
        }
        return infos to keys
    }

    /** One key: a click, or, only if Android refuses it, a tap at its centre. */
    private fun press(node: AccessibilityNodeInfo) {
        if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        if (bounds.isEmpty) return
        gesture(Path().apply { moveTo(bounds.exactCenterX(), bounds.exactCenterY()) }, TAP_MS)
    }

    /** Up the middle of the lock screen, to raise its keypad. Only while locked. */
    private fun swipeUp() {
        if (!locked()) return
        val metrics = resources.displayMetrics
        val x = metrics.widthPixels / 2f
        val path = Path().apply {
            moveTo(x, metrics.heightPixels * SWIPE_FROM)
            lineTo(x, metrics.heightPixels * SWIPE_TO)
        }
        gesture(path, SWIPE_MS)
    }

    /** The one place the app performs a gesture: [press] and [swipeUp] only (`UnlockScanTest`). */
    private fun gesture(path: Path, durationMs: Long) {
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        val latch = CountDownLatch(1)
        val callback = object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) = latch.countDown()
            override fun onCancelled(gestureDescription: GestureDescription?) = latch.countDown()
        }
        main.post { if (!dispatchGesture(gesture, callback, null)) latch.countDown() }
        latch.await(GESTURE_WAIT_MS, TimeUnit.MILLISECONDS)
    }

    /** Locks the phone again after a run this service unlocked. */
    private fun relock() {
        if (Build.VERSION.SDK_INT >= UnlockLogic.MIN_SDK) performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
    }

    private fun execute(routine: RoutineLogic.Routine, dryRun: Boolean): RoutineLogic.Result {
        val deadline = SystemClock.uptimeMillis() + RoutineLogic.RUN_DEADLINE_MS
        if (locked()) return RoutineLogic.Result(RoutineLogic.Outcome.BLOCKED, -1, "locked")

        val launch = packageManager.getLaunchIntentForPackage(routine.packageName)
            ?: return RoutineLogic.failure(0, -1, "app_missing")
        runningPackage = routine.packageName
        open(routine.packageName, launch, deadline, fresh = true)?.let { return RoutineLogic.failure(0, -1, it) }

        var tapped = 0
        // The field the last tap put the cursor in: typing goes only there (0.13.5).
        var anchor: RoutineLogic.Step? = null
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
                    val (nodes, pick) = findTarget(routine.packageName, deadline) { RoutineLogic.pickTarget(it, step) }
                        ?: return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "app_not_front")
                    when (pick) {
                        RoutineLogic.Pick.None -> return RoutineLogic.failure(tapped, index, "target_not_found")
                        RoutineLogic.Pick.Disabled -> return RoutineLogic.failure(tapped, index, "target_disabled")
                        is RoutineLogic.Pick.Many -> return RoutineLogic.failure(tapped, index, "target_ambiguous")
                        RoutineLogic.Pick.FieldChanged -> return RoutineLogic.failure(tapped, index, "field_changed")
                        is RoutineLogic.Pick.One -> {
                            // A dry run stops at the first action: everything before it was found.
                            if (dryRun) return RoutineLogic.Result(RoutineLogic.Outcome.DRY_RUN_OK, index)
                            val target = nodes[pick.index]
                            if (!click(target, routine.packageName)) {
                                return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "tap_refused")
                            }
                            tapped++
                            anchor = RoutineLogic.anchorAfter(anchor, step, target.isEditable)
                            lastChangeAt = SystemClock.uptimeMillis()
                        }
                    }
                }

                RoutineLogic.Kind.TYPE_TEXT, RoutineLogic.Kind.SUBMIT -> {
                    val submit = step.kind == RoutineLogic.Kind.SUBMIT
                    val (nodes, pick) = findTarget(routine.packageName, deadline) { RoutineLogic.anchoredField(it, anchor, needFocus = submit) }
                        ?: return RoutineLogic.failure(tapped, index, guardReason(routine) ?: "app_not_front")
                    when (pick) {
                        RoutineLogic.Pick.None -> return RoutineLogic.failure(tapped, index, "target_not_found")
                        RoutineLogic.Pick.Disabled -> return RoutineLogic.failure(tapped, index, "target_disabled")
                        is RoutineLogic.Pick.Many -> return RoutineLogic.failure(tapped, index, "target_ambiguous")
                        RoutineLogic.Pick.FieldChanged -> return RoutineLogic.failure(tapped, index, "field_changed")
                        is RoutineLogic.Pick.One -> {
                            if (dryRun) return RoutineLogic.Result(RoutineLogic.Outcome.DRY_RUN_OK, index)
                            val field = nodes[pick.index]
                            val (acted, problem) =
                                if (submit) submit(field, routine.packageName) else type(field, step.value, routine.packageName)
                            // The action counts once Android accepted it, even if the check after it fails.
                            if (acted) tapped++
                            lastChangeAt = SystemClock.uptimeMillis()
                            problem?.let { return RoutineLogic.failure(tapped, index, guardReason(routine) ?: it) }
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

    /**
     * The settled screen and what [pick] chose on it. While nothing matches
     * yet (a page still loading), looks again for up to [TARGET_WAIT_MS];
     * a disabled or ambiguous target is answered at once. Null when the
     * routine's app is no longer in front.
     */
    private fun findTarget(
        packageName: String,
        deadline: Long,
        pick: (List<RoutineLogic.Node>) -> RoutineLogic.Pick,
    ): Pair<List<AccessibilityNodeInfo>, RoutineLogic.Pick>? {
        val until = minOf(SystemClock.uptimeMillis() + TARGET_WAIT_MS, deadline)
        while (true) {
            waitUntilStable(deadline)
            val (nodes, infos) = snapshot(packageName) ?: return null
            val chosen = pick(infos)
            // A field the tap just focused may take a moment to report it: looked
            // at again, like a target not there yet, before "field_changed".
            val again = chosen == RoutineLogic.Pick.None || chosen == RoutineLogic.Pick.FieldChanged
            if (!again || SystemClock.uptimeMillis() >= until) return nodes to chosen
            SystemClock.sleep(POLL_MS)
        }
    }

    /**
     * Launches the app and waits until its window is in front: null when it
     * is, else why not. While the phone's "allow opening another app?" dialog
     * is up, the wait stretches to [RoutineLogic.CONFIRM_WAIT_MS] for the user.
     *
     * [fresh]: a routine starts the app on its first screen, not on whatever
     * it was left showing (FID still showed the last search's results, with no
     * field to type into). A screen task passes false: the app comes to the
     * front as it was ([RoutineLogic.launchFlags]). [cancel] ends the wait
     * early, checked every [POLL_MS].
     */
    private fun open(
        packageName: String,
        launch: Intent,
        deadline: Long,
        fresh: Boolean,
        cancel: () -> Boolean = { false },
    ): String? {
        lastChangeAt = SystemClock.uptimeMillis()
        val intent = launch.addFlags(RoutineLogic.launchFlags(fresh))
        main.post { startActivity(intent) }
        val start = SystemClock.uptimeMillis()
        var sawConfirm = false
        while (true) {
            if (cancel()) return "app_not_front"
            if (snapshot(packageName) != null) return null
            if (RoutineLogic.isLaunchConfirm(rootInActiveWindow?.packageName?.toString())) sawConfirm = true
            val limit = if (sawConfirm) RoutineLogic.CONFIRM_WAIT_MS else RoutineLogic.OPEN_TIMEOUT_MS
            val now = SystemClock.uptimeMillis()
            if (now - start >= limit || now >= deadline) break
            SystemClock.sleep(POLL_MS)
        }
        return when {
            locked() -> "locked"
            sawConfirm -> "launch_confirm"
            else -> "app_not_front"
        }
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

    /** The checks before typing or Enter: as [click]'s, and the node is still a field, not a password. */
    private fun fieldUsable(node: AccessibilityNodeInfo, packageName: String): Boolean {
        if (locked()) return false
        if (!node.refresh()) return false
        if (node.packageName?.toString() != packageName) return false
        if (!node.isVisibleToUser || !node.isEnabled || !node.isEditable || node.isPassword) return false
        return rootInActiveWindow?.packageName?.toString() == packageName
    }

    /**
     * Focuses the field and sets the routine's own text. Returns whether the
     * text was set (the app may have changed), and why the step failed, or null.
     */
    private fun type(node: AccessibilityNodeInfo, text: String, packageName: String): Pair<Boolean, String?> {
        if (!fieldUsable(node, packageName)) return false to "tap_refused"
        if (!node.isFocused) {
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            if (!node.refresh() || !node.isFocused) return false to "tap_refused"
        }
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false to "tap_refused"
        // Read back: an app that filtered or rewrote the text did not get what the routine says.
        val typed = if (node.refresh()) node.text?.toString() else null
        return true to (if (typed != null && RoutineLogic.normalize(typed) == RoutineLogic.normalize(text)) null else "tap_refused")
    }

    /** The keyboard's Enter / search key on the focused field. Android 11+ only. */
    private fun submit(node: AccessibilityNodeInfo, packageName: String): Pair<Boolean, String?> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false to "tap_refused"
        if (!fieldUsable(node, packageName) || !node.isFocused) return false to "tap_refused"
        val done = node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        return done to (if (done) null else "tap_refused")
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
        val windowId = root.windowId
        // Each entry carries its tap target and its path: child indexes from the root, "." between.
        val stack = ArrayDeque<Triple<AccessibilityNodeInfo, Int, String>>()
        stack.addLast(Triple(root, -1, ""))
        while (stack.isNotEmpty() && nodes.size < MAX_NODES) {
            val (node, parentTarget, path) = stack.removeLast()
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
                    focused = node.isFocused,
                    password = node.isPassword,
                    className = node.className?.toString(),
                    path = path,
                    windowId = windowId,
                    scrollable = node.isScrollable,
                    checkable = node.isCheckable,
                    checked = node.isChecked,
                ),
            )
            for (i in node.childCount - 1 downTo 0) {
                node.getChild(i)?.let { stack.addLast(Triple(it, target, if (path.isEmpty()) "$i" else "$path.$i")) }
            }
        }
        return nodes to infos
    }

    private fun waitUntilStable(deadline: Long, cancel: () -> Boolean = { false }) {
        val until = minOf(SystemClock.uptimeMillis() + RoutineLogic.STABLE_MAX_MS, deadline)
        while (SystemClock.uptimeMillis() < until) {
            if (cancel()) return
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

    // -- screen tasks (0.14) ------------------------------------------------------

    /** The node a screen action will act on: found once, by its binding, on a fresh snapshot. */
    class Target(val info: AccessibilityNodeInfo, val nodes: List<RoutineLogic.Node>, val index: Int) {
        val node: RoutineLogic.Node get() = nodes[index]
    }

    sealed class Found {
        class One(val target: Target) : Found()
        /** An end code: `screen_changed`, `target_ambiguous`, `left_app`, `locked`. */
        class Refused(val reason: String) : Found()
    }

    /**
     * What a screen task may do, for one package, on the worker thread only
     * (inside [screenTask]). [cancel] is the task's stop flag: every wait in
     * here looks at it every [POLL_MS].
     */
    inner class ScreenOps internal constructor(val packageName: String, private val cancel: () -> Boolean) {

        fun locked(): Boolean = (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

        /** Whether the task's app is the window in front. */
        fun inFront(): Boolean = rootInActiveWindow?.packageName?.toString() == packageName

        /** Why the task's app is not readable now: an end code. */
        fun whyNotFront(): String = if (locked()) "locked" else "left_app"

        /** Brings the task's app to the front as it was (never `CLEAR_TASK`). Null when it is in front, else an end code. */
        fun open(deadline: Long): String? {
            if (locked()) return "locked"
            val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return "app_missing"
            runningPackage = packageName
            return open(packageName, launch, deadline, fresh = false, cancel)
        }

        /** The settled screen, or null when the app is not in front or the phone is locked. */
        fun read(deadline: Long): List<RoutineLogic.Node>? {
            waitUntilStable(deadline, cancel)
            return snapshot(packageName)?.second
        }

        /** A fresh snapshot, and the one node with [binding] on it. */
        fun find(binding: String, deadline: Long): Found {
            waitUntilStable(deadline, cancel)
            val (infos, nodes) = snapshot(packageName) ?: return Found.Refused(whyNotFront())
            return when (val pick = ScreenLogic.resolveBinding(nodes, binding, packageName)) {
                is RoutineLogic.Pick.One -> Found.One(Target(infos[pick.index], nodes, pick.index))
                is RoutineLogic.Pick.Many -> Found.Refused("target_ambiguous")
                else -> Found.Refused("screen_changed")
            }
        }

        /**
         * The last checks before [fire] — [click]'s and [fieldUsable]'s, plus the
         * same window — without acting. Null when it may act, else an end code.
         */
        fun ready(action: ScreenLogic.Action, target: Target?): String? {
            if (locked()) return "locked"
            if (rootInActiveWindow?.packageName?.toString() != packageName) return "left_app"
            if (!action.bound) return null
            val info = target?.info ?: return "screen_changed"
            if (!info.refresh()) return "screen_changed"
            if (info.packageName?.toString() != packageName) return "left_app"
            if (info.windowId != target.node.windowId) return "screen_changed"
            if (!info.isVisibleToUser || !info.isEnabled) return "screen_changed"
            return when (action.kind) {
                "type" -> if (info.isEditable && !info.isPassword) null else "not_allowed"
                "submit" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && info.isEditable && !info.isPassword) null else "not_allowed"
                "scroll" -> if (info.isScrollable) null else "screen_changed"
                else -> null
            }
        }

        /**
         * Performs the action once; true when Android accepted it. Only after
         * [ready], inside the runner's dispatch gate. [input] is the approved
         * text a `type` sets.
         */
        fun fire(action: ScreenLogic.Action, target: Target?, input: String?): Boolean {
            val accepted = when (action.kind) {
                "tap" -> target != null && click(target.info, packageName)
                "type" -> target != null && input != null && type(target.info, input, packageName).first
                "submit" -> target != null && submit(target.info, packageName).first
                "scroll" -> target != null && target.info.performAction(
                    if (action.dir == "back") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
                )
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "wait" -> true
                else -> false
            }
            lastChangeAt = SystemClock.uptimeMillis()
            return accepted
        }

        /** After back: whether the task's app is still the window in front (else the task ends, `left_app`). */
        fun stillInApp(deadline: Long): Boolean {
            waitUntilStable(deadline, cancel)
            val until = minOf(SystemClock.uptimeMillis() + BACK_SETTLE_MS, deadline)
            while (true) {
                if (!locked() && rootInActiveWindow?.packageName?.toString() == packageName) return true
                if (cancel() || SystemClock.uptimeMillis() >= until) return false
                SystemClock.sleep(POLL_MS)
            }
        }
    }

    companion object {
        private const val POLL_MS = 250L
        /** After back, how long the window may take to settle on the task's app again. */
        private const val BACK_SETTLE_MS = 2_000L
        private const val MAX_NODES = 2_000
        private const val SCAN_SETTLE_MS = 2_000L
        /** How long a tap or typing step waits for its target to appear. */
        private const val TARGET_WAIT_MS = 10_000L
        private const val SYSTEM_UI = "com.android.systemui"
        /** How long the lock screen's keypad may take to come up. */
        private const val KEYPAD_WAIT_MS = 10_000L
        /** After the last key, how long the phone may take to open. */
        private const val OPEN_WAIT_MS = 5_000L
        private const val KEY_GAP_MS = 150L
        private const val TAP_MS = 50L
        private const val SWIPE_MS = 300L
        private const val SWIPE_FROM = 0.80f
        private const val SWIPE_TO = 0.30f
        /** A swipe once the screen is on, and one more if the keypad did not come up. */
        private val SWIPE_AFTER_MS = longArrayOf(1_200L, 4_500L)
        private val MAX_SWIPES = SWIPE_AFTER_MS.size
        private const val GESTURE_WAIT_MS = 1_000L
        const val UNLOCK_OPEN = "open"
        const val UNLOCK_TYPED = "unlocked"
        const val UNLOCK_NO_KEYPAD = "no_keypad"
        const val UNLOCK_STILL_LOCKED = "still_locked"

        @Volatile private var instance: RoutineAccessibilityService? = null
        private val worker = Executors.newSingleThreadExecutor()
        /** Jobs submitted and not finished, the running one included: relock only when it is the last. */
        private val pending = AtomicInteger(0)

        private fun submit(job: () -> Unit) {
            pending.incrementAndGet()
            worker.execute {
                try {
                    job()
                } finally {
                    pending.decrementAndGet()
                }
            }
        }
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

        /**
         * A claimed routine on a locked phone (0.17): unlock with [pin], run,
         * lock again. False when the service is off ([pin] is zeroed then too).
         * [done]: the unlock's code and the run's result, if it ran.
         */
        fun unlockAndRun(routine: RoutineLogic.Routine, pin: CharArray, done: (String, RoutineLogic.Result?) -> Unit): Boolean {
            val service = instance
            if (service == null) {
                pin.fill('0')
                return false
            }
            service.startUnlockAndRun(routine, pin, done)
            return true
        }

        /** A screen scan of [packageName]; false when the service is off. */
        fun scan(packageName: String, done: (List<RoutineLogic.ScanLine>?) -> Unit): Boolean {
            val service = instance ?: return false
            service.startScan(packageName, done)
            return true
        }

        /**
         * A screen task (0.14) on the same single [worker] as routines and
         * scans, so they never act at once. [block] gets a factory for the
         * task's [ScreenOps], once it knows the package (after the claim); the
         * factory gives null if the service went away. False when the service
         * is off.
         */
        fun screenTask(block: (ops: (packageName: String, cancel: () -> Boolean) -> ScreenOps?) -> Unit): Boolean {
            if (instance == null) return false
            submit {
                var used: RoutineAccessibilityService? = null
                try {
                    block { packageName, cancel -> instance?.also { used = it }?.ScreenOps(packageName, cancel) }
                } catch (_: Exception) {
                    // The runner reports its own failures; the worker must outlive any of them.
                } finally {
                    used?.runningPackage = null
                }
            }
            return true
        }

        /** After the routines or the screen allowlist change: listen to their apps only. */
        fun refreshPackages(@Suppress("UNUSED_PARAMETER") context: Context) {
            val service = instance ?: return
            main.post { service.applyPackages(emptyList()) }
        }
    }
}
