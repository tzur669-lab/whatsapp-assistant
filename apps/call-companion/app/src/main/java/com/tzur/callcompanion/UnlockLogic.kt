package com.tzur.callcompanion

/**
 * Unlocking with the stored PIN for a scheduled routine (0.17, plan
 * `docs/plans/routine-auto-unlock.md`): the pure parts, unit tested.
 *
 * A key is found by what it says, never by where it is, so a scrambled
 * keypad works. A digit with no key, or with more than one, refuses the
 * whole PIN before anything is pressed.
 */
object UnlockLogic {
    const val MIN_DIGITS = 4
    const val MAX_DIGITS = 16

    /** One element of the lock screen's window, as the service read it. */
    data class Key(
        val text: String?,
        val description: String?,
        val viewId: String?,
        val visible: Boolean,
        val enabled: Boolean,
    )

    /** Null when [pin] may be stored, else why not (a code). */
    fun pinProblem(pin: CharArray): String? = when {
        pin.size < MIN_DIGITS -> "too_short"
        pin.size > MAX_DIGITS -> "too_long"
        pin.any { it !in '0'..'9' } -> "not_digits"
        else -> null
    }

    /** Whether the two entries of the PIN are the same, without making strings of them. */
    fun sameEntry(a: CharArray, b: CharArray): Boolean = a.contentEquals(b)

    /**
     * The index in [keys] of the one key for [digit], or null. By view id
     * first (`…/key5`, Pixel and Samsung), else a key whose whole text, or the
     * first part of its description ("5,JKL"), is the digit.
     */
    fun keyFor(digit: Char, keys: List<Key>): Int? {
        if (digit !in '0'..'9') return null
        val usable = keys.withIndex().filter { it.value.visible && it.value.enabled }
        val byId = usable.filter { it.value.viewId?.endsWith("/key$digit") == true }
        if (byId.size == 1) return byId[0].index
        if (byId.size > 1) return null
        val byLabel = usable.filter { labelOf(it.value) == digit.toString() }
        return if (byLabel.size == 1) byLabel[0].index else null
    }

    /** The index of the one Enter key, or null (a keypad that confirms by itself has none). */
    fun enterKey(keys: List<Key>): Int? {
        val found = keys.withIndex().filter { it.value.visible && it.value.enabled && it.value.viewId?.endsWith("/key_enter") == true }
        return if (found.size == 1) found[0].index else null
    }

    /** The key index for every digit of [pin], in order; null if any digit has no single key. */
    fun plan(pin: CharArray, keys: List<Key>): List<Int>? {
        if (pinProblem(pin) != null) return null
        val out = ArrayList<Int>(pin.size)
        for (digit in pin) out.add(keyFor(digit, keys) ?: return null)
        return out
    }

    private fun labelOf(key: Key): String? {
        key.text?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return key.description?.split(',', ' ')?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** What the runner does with a locked phone and a claimed run. */
    enum class Decision { PIN, ASK }

    /**
     * [PIN] only when a PIN is stored and usable, auto-unlock has not turned
     * itself off, the routine is opted in with these very steps, and the
     * phone can be locked again afterwards. Anything else: [ASK] (today's
     * path — Extend Unlock or a finger).
     */
    fun decide(
        hasPin: Boolean,
        failed: Boolean,
        optedInHash: String?,
        stepHash: String,
        sdk: Int,
    ): Decision = if (hasPin && !failed && optedInHash == stepHash && sdk >= MIN_SDK) Decision.PIN else Decision.ASK

    /** `GLOBAL_ACTION_LOCK_SCREEN` is Android 9. */
    const val MIN_SDK = 28
}
