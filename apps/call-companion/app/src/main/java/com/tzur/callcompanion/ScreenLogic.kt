package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Node
import com.tzur.callcompanion.RoutineLogic.Pick
import java.security.MessageDigest
import java.text.Normalizer

/**
 * The screen agent's rules that need no Android (0.14, build spec
 * `docs/plans/screen-agent.md` sections A, D–G): the element list sent to the
 * server, the binding that finds a node again, the risk policy, the journal's
 * state machine, and the allowlist's blocked apps. The JVM tests pin all of it,
 * and `ScreenPolicyFixtureTest` checks the word lists and vectors against the
 * file the server's test reads too (`test/fixtures/screen-policy.json`).
 *
 * The phone is only eyes and hands: the server's model picks an element by its
 * index in the list, and the phone acts only on the one node whose binding it
 * computed itself — never by the index, never by coordinates.
 */
object ScreenLogic {

    // -- constants (spec A) ---------------------------------------------------

    const val MAX_STEPS = 12
    const val TASK_DEADLINE_MS = 4 * 60_000L
    const val MAX_ELEMENTS = 80
    const val MAX_LABEL = 80
    const val MAX_SCREEN_CHARS = 2_500
    const val MAX_CLASS = 40
    const val MAX_INPUTS = 3
    const val MAX_INPUT = 60
    const val MAX_APPS = 20
    /** The app's label as the server keeps it. */
    const val MAX_APP_LABEL = 60
    const val MIN_RETRY_MS = 2_000L
    const val MAX_RETRY_MS = 15_000L
    const val MAX_WAIT_SECONDS = 5

    /** Task ids, action ids, nonces and bindings: lowercase hex. */
    val ID = Regex("^[0-9a-f]{32}$")
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")

    fun validPackage(name: String): Boolean = PACKAGE.matches(name)

    /** Why the phone ends a task by itself (`/app/screen/result`, spec C). Anything else is sent as `error`. */
    val END_CODES = setOf(
        "stopped_user", "stopped_restart", "locked", "app_missing", "app_not_front", "launch_confirm",
        "left_app", "service_off", "deadline", "step_limit", "not_allowed", "screen_changed",
        "target_ambiguous", "uncertain", "unreachable", "error",
    )

    fun endCode(reason: String): String = if (reason in END_CODES) reason else "error"

    /**
     * Why an action was refused, as a report carries it: a closed list of its
     * own on the server (`stepReportSchema`), narrower than [END_CODES]. Any
     * stop, restart or deadline is `stopped`; anything else unknown is `error`.
     */
    val REPORT_REASONS = setOf("screen_changed", "target_ambiguous", "tap_refused", "not_allowed", "left_app", "stopped", "error")

    fun reportReason(code: String): String = when {
        code in REPORT_REASONS -> code
        code.startsWith("stopped") || code == "deadline" -> "stopped"
        else -> "error"
    }

    // -- risk policy (spec F) -------------------------------------------------

    /** Equal to `sensitive` in `test/fixtures/screen-policy.json`, in its order. */
    val SENSITIVE = listOf(
        "שלח", "שליחה", "לשלם", "תשלום", "שלם", "קנה", "קנייה", "רכישה", "לרכוש", "הזמן", "הזמנה", "מחק", "מחיקה",
        "הסר", "הסרה", "העבר", "העברה", "אשר", "בטל מנוי", "ביטול מנוי", "תרומה", "הפקד", "משוך", "משיכה", "חתום",
        "send", "pay", "buy", "purchase", "order", "checkout", "delete", "remove", "transfer", "confirm",
        "unsubscribe", "subscribe", "donate", "withdraw", "deposit", "erase",
    )

    /** Equal to `generic` in the fixture. */
    val GENERIC = listOf(
        "המשך", "הבא", "סיום", "סיים", "שמור", "שמירה", "אישור", "אוקיי", "אוקי", "בטל", "ביטול", "כן", "אני מסכים",
        "continue", "next", "done", "save", "ok", "okay", "submit", "finish", "yes", "apply", "cancel", "accept", "agree", "allow",
    )

    /** Equal to `search` in the fixture. */
    val SEARCH = listOf("חיפוש", "חפש", "search", "find")

    enum class Cls(val wire: String) {
        SAFE("safe"), UNCERTAIN("uncertain"), SENSITIVE("sensitive");

        companion object {
            fun of(wire: String?): Cls? = entries.firstOrNull { it.wire == wire }
        }
    }

    enum class Why(val wire: String) {
        SENSITIVE("sensitive"),
        ASK_EVERY_TAP("ask_every_tap"),
        UNLABELLED("unlabelled"),
        GENERIC("generic"),
        SUBMIT_NOT_SEARCH("submit_not_search"),
        AFTER_FORM("after_form");

        companion object {
            fun of(wire: String?): Why? = entries.firstOrNull { it.wire == wire }
        }
    }

    /**
     * One element as it goes on the wire (spec C, `El`). [f] holds the flags
     * in the order `c e s k x d o`; [b] is present exactly when [f] has `c`,
     * `e` or `s`.
     */
    data class Element(
        val i: Int = 0,
        val t: String? = null,
        val h: String? = null,
        val v: String? = null,
        val c: String? = null,
        val f: String = "",
        val b: String? = null,
    ) {
        val clickable: Boolean get() = 'c' in f
        val editable: Boolean get() = 'e' in f
    }

    private val INVISIBLE = Regex("[​-‏‪-‮⁦-⁩﻿]")
    private val NIQQUD = Regex("[֑-ׇ]")
    private val CAMEL = Regex("(\\p{Ll})(\\p{Lu})")
    private val NOT_WORD = Regex("[^\\p{L}\\p{N}]+")

    /**
     * Text as the policy compares it: NFC; no bidi marks, zero-width
     * characters or niqqud; a space inside camelCase; every run of characters
     * that is not a letter or a digit becomes one space; trimmed; lowercase.
     */
    fun normalize(text: String): String {
        var s = Normalizer.normalize(text, Normalizer.Form.NFC)
        s = INVISIBLE.replace(s, "")
        s = NIQQUD.replace(s, "")
        s = CAMEL.replace(s, "$1 $2")
        s = NOT_WORD.replace(s, " ")
        return s.trim().lowercase()
    }

    private fun isHebrew(word: String): Boolean = word.any { it in '֐'..'׿' }

    private val SENSITIVE_N = SENSITIVE.map(::normalize)
    private val GENERIC_N = GENERIC.map(::normalize)
    private val SEARCH_N = SEARCH.map(::normalize)

    /** A Hebrew word anywhere in the text; a Latin word at the start of a token. */
    private fun containsWord(value: String?, words: List<String>): Boolean {
        if (value == null) return false
        val text = normalize(value)
        if (text.isEmpty()) return false
        val tokens = text.split(' ')
        return words.any { word ->
            if (isHebrew(word)) text.contains(word) else tokens.any { it.startsWith(word) }
        }
    }

    /** A whole token, or (a phrase) the whole text. */
    private fun genericWord(value: String?): Boolean {
        if (value == null) return false
        val text = normalize(value)
        if (text.isEmpty()) return false
        val tokens = text.split(' ')
        return GENERIC_N.any { word -> if (word.contains(' ')) text == word else word in tokens }
    }

    private fun absent(value: String?): Boolean = value == null || normalize(value).isEmpty()

    /** Whether a field is a search field: a search word in its hint, view id or label. */
    fun isSearchField(element: Element?): Boolean =
        element != null && listOf(element.h, element.v, element.t).any { containsWord(it, SEARCH_N) }

    /**
     * The risk class of one action on one element (spec F), first match wins.
     * [action] is the action's kind (`tap`, `submit`, `type`, `scroll`,
     * `back`, `wait`); an unknown kind is treated as the highest risk.
     */
    fun riskClass(action: String, element: Element?, askEveryTap: Boolean, typedNonSearch: Boolean): Pair<Cls, Why?> =
        when (action) {
            "scroll", "back", "wait" -> Cls.SAFE to null
            "type" -> if (askEveryTap) Cls.UNCERTAIN to Why.ASK_EVERY_TAP else Cls.SAFE to null
            "tap", "submit" -> {
                val t = element?.t
                val v = element?.v
                when {
                    containsWord(t, SENSITIVE_N) || containsWord(v, SENSITIVE_N) -> Cls.SENSITIVE to Why.SENSITIVE
                    askEveryTap -> Cls.UNCERTAIN to Why.ASK_EVERY_TAP
                    action == "tap" && absent(t) && absent(v) -> Cls.UNCERTAIN to Why.UNLABELLED
                    genericWord(t) || genericWord(v) -> Cls.UNCERTAIN to Why.GENERIC
                    action == "submit" && !isSearchField(element) -> Cls.UNCERTAIN to Why.SUBMIT_NOT_SEARCH
                    action == "tap" && element?.editable != true && typedNonSearch -> Cls.UNCERTAIN to Why.AFTER_FORM
                    else -> Cls.SAFE to null
                }
            }
            else -> Cls.SENSITIVE to Why.SENSITIVE
        }

    /** The higher of two classes; on a tie, the first. */
    fun higher(a: Pair<Cls, Why?>, b: Pair<Cls, Why?>): Pair<Cls, Why?> = if (b.first > a.first) b else a

    /**
     * The phone's own class for an action on node [index] (plan §3: built from
     * the full node). The label is not cut and is tried as each of its sources
     * — the text, the description, the texts under it, and the cut label the
     * server saw — and the highest class wins, so the phone is never less
     * careful than the server about the same node.
     */
    fun ownClass(
        action: String,
        nodes: List<Node>,
        index: Int,
        packageName: String,
        askEveryTap: Boolean,
        typedNonSearch: Boolean,
    ): Pair<Cls, Why?> {
        if (action != "tap" && action != "submit" && action != "type") {
            return riskClass(action, null, askEveryTap, typedNonSearch)
        }
        val base = elementOf(nodes, index, packageName, 0) ?: return riskClass(action, null, askEveryTap, typedNonSearch)
        val node = nodes[index]
        val labels = listOfNotNull(
            base.t,
            clean(node.text)?.takeUnless { node.password },
            clean(node.description),
            childLabel(nodes, index),
        ).distinct()
        val candidates = if (labels.isEmpty()) listOf(base.copy(t = null)) else labels.map { base.copy(t = it) }
        return candidates
            .map { riskClass(action, it, askEveryTap, typedNonSearch) }
            .reduce(::higher)
    }

    /** The node's label, uncut: what the approval notification names on the phone. */
    fun fullLabel(nodes: List<Node>, index: Int): String? = fullLabel(nodes, index, pathIndex(nodes))

    private fun fullLabel(nodes: List<Node>, index: Int, byPath: Map<String, Int>): String? {
        val node = nodes.getOrNull(index) ?: return null
        return clean(node.text)?.takeUnless { node.password }
            ?: clean(node.description)
            ?: childLabel(nodes, index)
            ?: lender(nodes, index, byPath)?.let { ownLabel(nodes[it]) }
    }

    private fun ownLabel(node: Node): String? = clean(node.text)?.takeUnless { node.password } ?: clean(node.description)

    private fun pathIndex(nodes: List<Node>): Map<String, Int> =
        HashMap<String, Int>(nodes.size * 2).apply { nodes.forEachIndexed { i, n -> putIfAbsent(n.path, i) } }

    /**
     * The container that lends actionable node [index] its label (Compose
     * screens such as Waze's, 2026-10-13: the label sits on a plain node above
     * the clickable, not under it). The nearest labelled ancestor, only when it
     * is visible, not inside a clickable, and no actionable node lies between
     * them — so only the outermost actionable node of the container borrows it.
     */
    private fun lender(nodes: List<Node>, index: Int, byPath: Map<String, Int>): Int? {
        if (!actionable(nodes[index])) return null
        var path = nodes[index].path
        while (path.isNotEmpty()) {
            path = if ('.' in path) path.substringBeforeLast('.') else ""
            val parent = byPath[path] ?: return null
            val node = nodes[parent]
            if (actionable(node)) return null
            if (ownLabel(node) != null) return parent.takeIf { node.visible && node.target < 0 }
        }
        return null
    }

    // -- elements (spec D) ------------------------------------------------------

    private fun clean(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }

    /** Cut to [MAX_LABEL] characters, never between the halves of a surrogate pair. */
    fun cut(value: String, max: Int = MAX_LABEL): String {
        if (value.length <= max) return value
        val end = if (Character.isHighSurrogate(value[max - 1])) max - 1 else max
        return value.substring(0, end)
    }

    private fun actionable(node: Node): Boolean = node.clickable || node.editable || node.scrollable

    /** The visible, non-actionable nodes a tap on [index] would click, by text (else description). */
    private fun childLabel(nodes: List<Node>, index: Int): String? {
        val parts = nodes.withIndex()
            .filter { (j, n) -> j != index && n.target == index && n.visible && !actionable(n) }
            .mapNotNull { (_, n) -> clean(n.text) ?: clean(n.description) }
        return parts.joinToString(" · ").ifEmpty { null }
    }

    private fun shortId(viewId: String?): String? = clean(viewId?.substringAfter(":id/"))

    private fun simpleClass(className: String?): String? =
        className?.substringAfterLast('.')
            ?.filter { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '$' }
            ?.take(MAX_CLASS)
            ?.ifEmpty { null }

    /** The flags in the wire's order: `c e s k x d o`. */
    fun flags(node: Node): String = buildString {
        if (node.clickable) append('c')
        if (node.editable) append('e')
        if (node.scrollable) append('s')
        if (node.checkable) append('k')
        if (node.checked) append('x')
        if (!node.enabled) append('d')
        if (node.focused) append('o')
    }

    /**
     * Node [index] as an element numbered [number], or null when it is not one
     * (invisible, or neither actionable nor a read-only text). Labels are cut.
     */
    private fun elementOf(
        nodes: List<Node>,
        index: Int,
        packageName: String,
        number: Int,
        byPath: Map<String, Int> = pathIndex(nodes),
    ): Element? {
        val node = nodes[index]
        if (!node.visible) return null
        val isActionable = actionable(node)
        val label = if (isActionable) {
            fullLabel(nodes, index, byPath)
        } else {
            // A read-only text: only one that no tap would click (no clickable ancestor).
            if (node.target >= 0) return null
            clean(node.text)?.takeUnless { node.password } ?: clean(node.description) ?: return null
        }
        return Element(
            i = number,
            t = label?.let { cut(it) },
            h = clean(node.hint)?.let { cut(it) },
            v = shortId(node.viewId)?.let { cut(it) },
            c = simpleClass(node.className),
            f = flags(node),
            b = if (isActionable) binding(node, packageName) else null,
        )
    }

    /** Node [index] as the element it would be on the list (labels cut), or null when it is none. */
    fun elementAt(nodes: List<Node>, index: Int, packageName: String): Element? =
        if (index in nodes.indices) elementOf(nodes, index, packageName, 0) else null

    /**
     * The screen as the server sees it (spec D): the visible actionable nodes
     * and the read-only texts outside any clickable one, in tree order. Stops at
     * [MAX_ELEMENTS], or before the labels together pass [MAX_SCREEN_CHARS].
     */
    fun elements(nodes: List<Node>, packageName: String): List<Element> {
        val out = ArrayList<Element>()
        var chars = 0
        val byPath = pathIndex(nodes)
        // A container whose label an unlabelled clickable took is not listed again
        // as a text: the model would tap it, and a text is not tappable.
        val lenders = nodes.indices
            .filter { nodes[it].visible && actionable(nodes[it]) && fullLabel(nodes, it, byPath) != null }
            .filter { ownLabel(nodes[it]) == null && childLabel(nodes, it) == null }
            .mapNotNull { lender(nodes, it, byPath) }
            .toSet()
        for (index in nodes.indices) {
            if (index in lenders) continue
            val element = elementOf(nodes, index, packageName, out.size, byPath) ?: continue
            val size = (element.t?.length ?: 0) + (element.h?.length ?: 0) + (element.v?.length ?: 0)
            if (out.size >= MAX_ELEMENTS || chars + size > MAX_SCREEN_CHARS) break
            chars += size
            out.add(element)
        }
        return out
    }

    /** False when no element is clickable and labelled: the server answers `tree_unusable` too. */
    fun usable(elements: List<Element>): Boolean = elements.any { it.clickable && (it.t != null || it.v != null) }

    /** SHA-256 hex of the elements, flags and bindings included: "did the screen change?". */
    fun screenHash(elements: List<Element>): String {
        val canonical = buildString {
            append("v1\n")
            for (e in elements) {
                listOf(e.i.toString(), e.t ?: "", e.h ?: "", e.v ?: "", e.c ?: "", e.f, e.b ?: "")
                    .joinTo(this, US)
                append('\n')
            }
        }
        return sha256Hex(canonical)
    }

    // -- binding (spec E) ------------------------------------------------------

    private const val US = "\u001f"

    /**
     * Who a node is, so a fresh snapshot can find it again: the window, its
     * place in the tree, what kind of view it is and what it says. An editable
     * node's own text is left out (its hint, id and path name it), so typing
     * into it does not change it; `enabled`, `visible` and `password` are left
     * out too and checked when acting. First 32 hex of the SHA-256.
     */
    fun binding(node: Node, packageName: String): String {
        fun bit(value: Boolean) = if (value) "1" else "0"
        val parts = listOf(
            "v1", packageName, node.windowId.toString(), node.path, node.className ?: "",
            bit(node.editable), bit(node.clickable), bit(node.checkable), bit(node.checked),
            node.viewId ?: "", node.hint ?: "", node.description ?: "",
            if (node.editable) "" else node.text ?: "",
        )
        return sha256Hex(parts.joinToString(US)).take(32)
    }

    /** The node with this binding on a fresh snapshot: exactly one, none, or several. */
    fun resolveBinding(nodes: List<Node>, binding: String, packageName: String): Pick {
        val hits = nodes.indices.filter { binding(nodes[it], packageName) == binding }
        return when (hits.size) {
            0 -> Pick.None
            1 -> Pick.One(hits[0])
            else -> Pick.Many(hits.size)
        }
    }

    // -- the journal (spec G, plan §9.9) ----------------------------------------

    /** An action's status in the phone's journal. No entry at all is "new". */
    enum class Status(val wire: String, val final: Boolean) {
        HELD("held", false),
        STARTED("started", false),
        DISPATCHED("dispatched", true),
        NOT_ACCEPTED("not_accepted", true),
        REFUSED("refused", true),
        UNCERTAIN("uncertain", true);

        companion object {
            fun of(wire: String?): Status? = entries.firstOrNull { it.wire == wire }
        }
    }

    enum class Event { START, HOLD, REFUSE, DISPATCHED, NOT_ACCEPTED, UNCERTAIN, RESTART }

    /**
     * The journal's one table of moves. [from] null is a new action. Null
     * back: the move is not allowed and nothing may happen. A final status
     * never moves; `held → started` happens once, because a started action is
     * no longer held.
     */
    fun next(from: Status?, event: Event): Status? = when (from) {
        null -> when (event) {
            Event.START -> Status.STARTED
            Event.HOLD -> Status.HELD
            Event.REFUSE -> Status.REFUSED
            else -> null
        }
        Status.HELD -> when (event) {
            Event.START -> Status.STARTED
            Event.REFUSE, Event.RESTART -> Status.REFUSED
            else -> null
        }
        Status.STARTED -> when (event) {
            Event.DISPATCHED -> Status.DISPATCHED
            Event.NOT_ACCEPTED -> Status.NOT_ACCEPTED
            Event.UNCERTAIN, Event.RESTART -> Status.UNCERTAIN
            else -> null
        }
        else -> null
    }

    // -- the wire's shapes, parsed (Api reads the JSON into these) ---------------

    /** What step N+1 says about step N's action. Only a final status is ever reported. */
    data class Report(val actionId: String, val status: Status, val reason: String? = null)

    data class Action(
        val kind: String,
        val b: String? = null,
        val input: Int = 0,
        val dir: String? = null,
        val seconds: Int = 0,
    ) {
        val bound: Boolean get() = kind == "tap" || kind == "submit" || kind == "type" || kind == "scroll"
    }

    /** Whether an action from the server has a shape the phone will run, with [inputCount] inputs claimed. */
    fun validAction(action: Action, inputCount: Int): Boolean = when (action.kind) {
        "tap", "submit" -> action.b != null && ID.matches(action.b)
        "type" -> action.b != null && ID.matches(action.b) && action.input in 1..minOf(inputCount, MAX_INPUTS)
        "scroll" -> action.b != null && ID.matches(action.b) && (action.dir == "fwd" || action.dir == "back")
        "back" -> action.b == null
        "wait" -> action.seconds in 1..MAX_WAIT_SECONDS
        else -> false
    }

    data class Grant(
        val taskId: String,
        val step: Int,
        val actionId: String,
        val binding: String?,
        val packageName: String,
        val maxClass: Cls,
        val expiresAt: Long,
    )

    sealed class Answer {
        data class Act(val step: Int, val actionId: String, val action: Action, val cls: Cls) : Answer()
        data class Approval(
            val step: Int,
            val actionId: String,
            val action: Action,
            val cls: Cls,
            val why: String?,
            val nonce: String,
            val expiresAt: Long,
        ) : Answer()
        data class Released(val step: Int, val actionId: String, val action: Action, val grant: Grant) : Answer()
        data class Wait(val retryAfterMs: Long) : Answer()
        data class End(val outcome: String) : Answer()
        data class Stopped(val reason: String) : Answer()
    }

    /**
     * Why a released action may not run (plan §9.1), or null when it may: the
     * grant is for this task, step, action, binding and app; the phone's own
     * class is at most [Grant.maxClass]; it has not expired ([now] on the
     * phone's wall clock, the same clock the claim's deadline was read on).
     */
    fun grantProblem(
        grant: Grant,
        taskId: String,
        step: Int,
        actionId: String,
        action: Action,
        packageName: String,
        ownClass: Cls,
        now: Long,
    ): String? = when {
        grant.taskId != taskId || grant.step != step || grant.actionId != actionId -> "not_allowed"
        grant.packageName != packageName -> "not_allowed"
        grant.binding != action.b -> "not_allowed"
        ownClass > grant.maxClass -> "not_allowed"
        now >= grant.expiresAt -> "deadline"
        else -> null
    }

    /** The approval wait's backup polls: 3, 5, 8, 10, 10, … seconds (plan §9.7). */
    fun pollDelayMs(attempt: Int): Long = when (attempt) {
        0 -> 3_000L
        1 -> 5_000L
        2 -> 8_000L
        else -> 10_000L
    }

    /** A `wait` answer's delay, kept inside 2–15 s whatever the server said. */
    fun retryDelayMs(retryAfterMs: Long): Long = retryAfterMs.coerceIn(MIN_RETRY_MS, MAX_RETRY_MS)

    /**
     * The phone's deadline on its own monotonic clock: four minutes from the
     * claim, or sooner when the server's `deadlineAt` (read against the phone's
     * wall clock at the claim) says so.
     */
    fun phoneDeadline(claimUptime: Long, wallNow: Long, deadlineAt: Long): Long =
        claimUptime + minOf(TASK_DEADLINE_MS, maxOf(0L, deadlineAt - wallNow))

    // -- the allowlist ----------------------------------------------------------

    data class AllowedApp(val packageName: String, val label: String, val askEveryTap: Boolean = false)

    /**
     * Apps the agent may never act in (decision 2, plan): settings, the system
     * UI, lock screen and launcher, messaging and mail, banks, payments and
     * stores, the phone itself. Exact names, then words in the package name.
     */
    val BLOCKED_PACKAGES = setOf(
        // settings, system, security
        "com.android.settings", "com.samsung.android.settings", "com.android.systemui",
        "com.android.packageinstaller", "com.google.android.packageinstaller",
        "com.android.permissioncontroller", "com.google.android.permissioncontroller",
        "com.android.phone", "com.android.server.telecom", "com.android.vending",
        // messaging and mail
        "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.telegram.messenger.web",
        "org.thoughtcrime.securesms", "com.google.android.apps.messaging", "com.samsung.android.messaging",
        "com.android.mms", "com.google.android.gm", "com.microsoft.office.outlook",
        // Israeli banks and payments
        "com.ideomobile.hapoalim", "com.leumi.leumiwallet", "com.ideomobile.discount",
        "com.MizrahiTefahot.nh", "com.fibi.nativeapp", "com.bnhp.payments.paymentsapp",
        "com.payboxapp", "com.pepper.ldb", "com.onoapps.leumi.pepper",
        "com.google.android.apps.walletnfcrel", "com.google.android.apps.nbu.paisa.user",
    )

    val BLOCKED_WORDS = listOf(
        "bank", "wallet", "pay", "messag", "sms", "settings", "keyguard", "systemui", "launcher",
        "dialer", "hapoalim", "leumi", "mizrahi", "fibi", "ideomobile", "pepper",
    )

    /** Whether [packageName] may never be allowlisted. [own] is this app; [launchers] the home apps. */
    fun blocked(packageName: String, own: String, launchers: Set<String> = emptySet()): Boolean {
        val lower = packageName.lowercase()
        return packageName == own ||
            packageName in launchers ||
            BLOCKED_PACKAGES.any { it.lowercase() == lower } ||
            BLOCKED_WORDS.any { lower.contains(it) }
    }

    private fun sha256Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
