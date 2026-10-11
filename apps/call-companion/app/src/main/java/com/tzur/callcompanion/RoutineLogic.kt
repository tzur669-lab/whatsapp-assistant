package com.tzur.callcompanion

import java.security.MessageDigest

/**
 * Routines (0.13): a named, closed list of steps the user builds on this phone
 * — open one app, wait for a text, tap one element, type a fixed text, check
 * that a text appeared.
 * Never written by the model, never sent by the server; the server will only
 * ever name a routine (PLAN §6.27, stage 2). These are the rules that need no
 * Android, so the JVM tests can pin them: validation, the step hash, and which
 * element a tap may hit.
 *
 * Safety boundary: the only text typed is the one the user wrote into the
 * routine (0.13.1), never into a password field; there is no scrolling, long
 * press, coordinate gesture or system action, and every step acts only inside
 * [Routine.packageName].
 */
object RoutineLogic {

    enum class Kind {
        /** Wait until a text is on the screen, up to [Step.seconds]. */
        WAIT_FOR_TEXT,
        /** Tap the one element whose text or description is exactly this. */
        TAP_TEXT,
        /** Tap the one element with this view id (`com.app:id/clock_in` or `clock_in`). */
        TAP_ID,
        /** After the taps: the text that proves it worked, up to [Step.seconds]. */
        EXPECT_TEXT,
        /**
         * After the taps: the element with this text is now off (disabled) —
         * e.g. "כניסה" greys out once the punch registered. Proof for an app
         * whose texts never change. Up to [Step.seconds].
         */
        EXPECT_DISABLED,
        /** Pause [Step.seconds]. */
        WAIT,
        /**
         * Type this fixed text into the field (0.13.1): the focused one, else
         * the only one on the screen. Never a password field.
         */
        TYPE_TEXT,
        /** The keyboard's Enter / search key on the focused field (Android 11+). No text. */
        SUBMIT,
    }

    data class Step(val kind: Kind, val value: String = "", val seconds: Int = DEFAULT_SECONDS) {
        val isTap: Boolean get() = kind == Kind.TAP_TEXT || kind == Kind.TAP_ID
        val isCheck: Boolean get() = kind == Kind.EXPECT_TEXT || kind == Kind.EXPECT_DISABLED
        /** Changes something in the app: a tap, typing, or the keyboard's Enter. */
        val isAction: Boolean get() = isTap || kind == Kind.TYPE_TEXT || kind == Kind.SUBMIT
    }

    data class Routine(
        val id: String,
        val name: String,
        val packageName: String,
        val appLabel: String,
        val steps: List<Step>,
    ) {
        /** A routine that taps but never checks a result can only say "tapped, not verified". */
        val verifies: Boolean get() = steps.any { it.isCheck }
    }

    const val MAX_NAME = 40
    const val MAX_TEXT = 60
    /** The app's label as the server keeps it (stage 2). */
    const val MAX_APP_LABEL = 60
    const val MAX_STEPS = 10
    /** As many as the server keeps (stage 2). */
    const val MAX_ROUTINES = 20
    const val DEFAULT_SECONDS = 15
    const val MAX_WAIT_SECONDS = 20
    const val MAX_PAUSE_SECONDS = 5

    /** How long the app may take to come to the front after it is launched. */
    const val OPEN_TIMEOUT_MS = 10_000L
    /** While the phone asks "allow this app to open that one?", wait this long for the user. */
    const val CONFIRM_WAIT_MS = 30_000L

    /**
     * The phone makers' "allow app A to open app B?" dialogs (ColorOS/OxygenOS,
     * MIUI). Seen in front instead of the routine's app, the run waits for
     * the user and, if nobody answers, says so instead of "did not open".
     * The service listens to these packages too, only to see the dialog in
     * front; no step ever acts in them (every step checks the routine's app).
     */
    val LAUNCH_CONFIRM_PACKAGES = setOf(
        "com.oplus.securitypermission",
        "com.coloros.securitypermission",
        "com.miui.securitycenter",
    )

    fun isLaunchConfirm(packageName: String?): Boolean = packageName in LAUNCH_CONFIRM_PACKAGES
    /** A tap waits until the screen stopped changing for this long … */
    const val STABLE_MS = 500L
    /** … but no longer than this. */
    const val STABLE_MAX_MS = 3_000L
    /** The whole run, every step included; past it the run stops where it is. */
    const val RUN_DEADLINE_MS = 4 * 60_000L

    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")
    private val VIEW_ID = Regex("^([A-Za-z][A-Za-z0-9_.]*:id/)?[A-Za-z0-9_]{1,80}$")

    /** Why a routine cannot be saved, or null when it can. Codes, shown by the screen. */
    fun problem(routine: Routine): String? {
        if (routine.name.isBlank() || routine.name.length > MAX_NAME) return "name"
        if (!PACKAGE.matches(routine.packageName)) return "app"
        if (routine.steps.isEmpty() || routine.steps.size > MAX_STEPS) return "steps"
        if (routine.steps.none { it.isAction }) return "no_tap"
        if (routine.steps.any { stepProblem(it) != null }) return "step"
        val lastAction = routine.steps.indexOfLast { it.isAction }
        val firstExpect = routine.steps.indexOfFirst { it.isCheck }
        if (firstExpect in 0 until lastAction) return "expect_order"
        return null
    }

    /**
     * Why one step is not valid, or null: `text` (empty or too long), `id`
     * (not a view id — usually words from the screen, which belong in
     * TAP_TEXT), `seconds` (out of range). Checked as the step is added.
     */
    fun stepProblem(step: Step): String? = when (step.kind) {
        Kind.WAIT_FOR_TEXT, Kind.TAP_TEXT, Kind.EXPECT_TEXT, Kind.EXPECT_DISABLED -> when {
            normalize(step.value).isEmpty() || step.value.length > MAX_TEXT -> "text"
            step.seconds !in 1..MAX_WAIT_SECONDS -> "seconds"
            else -> null
        }
        Kind.TAP_ID -> if (VIEW_ID.matches(step.value.trim())) null else "id"
        Kind.WAIT -> if (step.seconds in 1..MAX_PAUSE_SECONDS) null else "seconds"
        Kind.TYPE_TEXT ->
            if (normalize(step.value).isEmpty() || step.value.length > MAX_TEXT) "text" else null
        Kind.SUBMIT -> if (step.value.isEmpty()) null else "text"
    }

    /**
     * SHA-256 of the canonical step list and target app. The server will store
     * it when a run is confirmed and refuse the run if the steps changed since
     * (stage 2). The name is not part of it: renaming changes nothing that runs.
     * A typed text goes in as written (trimmed), not normalized: "ABC" and
     * "abc" are different texts typed, so a run confirmed for one never types
     * the other. Every other kind keeps its 0.13.0 line, so its hash is unchanged.
     */
    fun stepHash(routine: Routine): String {
        val canonical = buildString {
            append("v1\n").append(routine.packageName).append('\n')
            for (step in routine.steps) {
                val value = if (step.kind == Kind.TYPE_TEXT) step.value.trim() else normalize(step.value)
                append(step.kind.name).append('\t').append(value)
                    .append('\t').append(step.seconds).append('\n')
            }
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * Text as it is compared: no bidi marks or zero-width characters, spaces
     * collapsed, case folded. Matching is on the whole text, never "contains":
     * "כניסה" must not hit "כניסה מאוחרת".
     */
    fun normalize(text: String): String =
        text.replace(INVISIBLE, "").replace(SPACES, " ").trim().lowercase()

    private val INVISIBLE = Regex("[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]")
    private val SPACES = Regex("\\s+")

    /**
     * One element of the screen as the service flattened it. [target] is the
     * index of the element a tap on it would click: itself when clickable, else
     * its nearest clickable ancestor, else -1.
     */
    data class Node(
        val text: String?,
        val description: String?,
        val viewId: String?,
        val visible: Boolean,
        val enabled: Boolean,
        val target: Int,
        /** A field's grey placeholder. A tap may name a field by it; a check never counts it. */
        val hint: String? = null,
        val editable: Boolean = false,
        val clickable: Boolean = false,
        val focused: Boolean = false,
        val password: Boolean = false,
    )

    sealed class Pick {
        data class One(val index: Int) : Pick()
        object None : Pick()
        /** Found once, but switched off right now — nothing is tapped. */
        object Disabled : Pick()
        data class Many(val count: Int) : Pick()
    }

    /**
     * Whether [text] is anywhere visible on the screen, as a whole text or
     * description. A field never counts: its content may be what the routine
     * typed, which proves nothing.
     */
    fun hasText(nodes: List<Node>, text: String): Boolean {
        val wanted = normalize(text)
        return nodes.any { it.visible && !it.editable && (matches(it.text, wanted) || matches(it.description, wanted)) }
    }

    /**
     * The one element a tap step may click. Every visible element that matches
     * is mapped to what a tap on it clicks; the targets must be exactly one,
     * visible and enabled. None or several → nothing is tapped.
     */
    fun pickTarget(nodes: List<Node>, step: Step): Pick {
        val wanted = normalize(step.value)
        val wantedId = step.value.trim()
        val hits = nodes.filter { node ->
            node.visible && when (step.kind) {
                // A field is named by its placeholder, never by what is typed in it.
                Kind.TAP_TEXT -> (!node.editable && (matches(node.text, wanted) || matches(node.description, wanted))) ||
                    matches(node.hint, wanted)
                Kind.TAP_ID -> node.viewId != null && idMatches(node.viewId, wantedId)
                else -> false
            }
        }
        if (hits.isEmpty()) return Pick.None
        val targets = hits.map { it.target }.distinct()
        if (targets.size > 1) return Pick.Many(targets.size)
        val target = nodes.getOrNull(targets[0])
        return when {
            target == null || !target.visible -> Pick.None
            !target.enabled -> Pick.Disabled
            else -> Pick.One(targets[0])
        }
    }

    /**
     * The field a typing step types into, or SUBMIT presses Enter on: the one
     * focused field, else (unless [needFocus]) the only field on the screen.
     * Password fields are never candidates. None or several → nothing is typed.
     */
    fun pickField(nodes: List<Node>, needFocus: Boolean): Pick {
        val fields = nodes.withIndex().filter { (_, n) -> n.visible && n.editable && !n.password }
        val focused = fields.filter { it.value.focused }
        val chosen = when {
            focused.size == 1 -> focused[0]
            focused.size > 1 -> return Pick.Many(focused.size)
            needFocus || fields.isEmpty() -> return Pick.None
            fields.size > 1 -> return Pick.Many(fields.size)
            else -> fields[0]
        }
        return if (chosen.value.enabled) Pick.One(chosen.index) else Pick.Disabled
    }

    /**
     * Whether the one element named [text] is now switched off. Not found, or
     * found more than once, is not proof; a field never counts.
     */
    fun isDisabled(nodes: List<Node>, text: String): Boolean {
        val wanted = normalize(text)
        val targets = nodes
            .filter { it.visible && !it.editable && (matches(it.text, wanted) || matches(it.description, wanted)) }
            .map { if (it.target >= 0) it.target else -1 }
            .distinct()
        if (targets.size != 1 || targets[0] < 0) return false
        return nodes.getOrNull(targets[0])?.enabled == false
    }

    private fun matches(value: String?, wanted: String): Boolean =
        value != null && normalize(value) == wanted

    /** `clock_in` matches `com.app:id/clock_in`; a full id must match whole. */
    private fun idMatches(viewId: String, wanted: String): Boolean =
        if (wanted.contains(":id/")) viewId == wanted else viewId.substringAfter(":id/") == wanted

    /** One line of a screen scan: what the service can read, shown only on this phone. */
    data class ScanLine(
        val text: String?,
        val hint: String?,
        val viewId: String?,
        val clickable: Boolean,
        val enabled: Boolean,
        val editable: Boolean,
    )

    const val MAX_SCAN_LINES = 80

    /**
     * What a routine could use on this screen: every visible element with a
     * text, a description, a placeholder or a view id, in screen order, once
     * each. [ScanLine.clickable] is whether a tap on it would click something.
     */
    fun scan(nodes: List<Node>): List<ScanLine> {
        val seen = HashSet<String>()
        val lines = ArrayList<ScanLine>()
        for (node in nodes) {
            if (!node.visible) continue
            val text = (node.text ?: node.description)?.trim()?.takeIf { it.isNotEmpty() }
            val hint = node.hint?.trim()?.takeIf { it.isNotEmpty() && it != text }
            val id = node.viewId?.substringAfter(":id/")?.takeIf { it.isNotEmpty() }
            if (text == null && hint == null && id == null) continue
            val line = ScanLine(text, hint, id, node.target >= 0, node.enabled, node.editable)
            if (seen.add(line.toString())) lines.add(line)
            if (lines.size >= MAX_SCAN_LINES) break
        }
        return lines
    }

    /** How a run ended. Only [VERIFIED] means the app showed the expected result. */
    enum class Outcome {
        /** Every tap ran and the check step (EXPECT_TEXT or EXPECT_DISABLED) passed. */
        VERIFIED,
        /** Every action ran; the routine has no check step, so the result is not known. */
        TAPPED_UNVERIFIED,
        /** Stopped before any action (tap or typing): nothing happened in the app. */
        FAILED_BEFORE_TAP,
        /** Stopped after an action (tap or typing): something may have happened. */
        FAILED_AFTER_TAP,
        /** Dry run: everything up to the first action was found; nothing was tapped or typed. */
        DRY_RUN_OK,
        /** Refused before starting: the phone is locked or the service is off. */
        BLOCKED,
    }

    /** Where a failure happened and why, as codes. Never screen text. */
    data class Result(val outcome: Outcome, val step: Int = -1, val reason: String = "")

    /** The outcome of a run that stopped at [reason] after [tapped] actions. */
    fun failure(tapped: Int, step: Int, reason: String): Result =
        Result(if (tapped > 0) Outcome.FAILED_AFTER_TAP else Outcome.FAILED_BEFORE_TAP, step, reason)
}
