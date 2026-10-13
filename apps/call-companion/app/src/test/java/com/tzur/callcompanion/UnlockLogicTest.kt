package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unlocking with the stored PIN (0.17): which key gets pressed, and when the runner may try. */
class UnlockLogicTest {
    private fun key(
        text: String? = null,
        desc: String? = null,
        id: String? = null,
        visible: Boolean = true,
        enabled: Boolean = true,
        clickable: Boolean = true,
    ) = UnlockLogic.Key(text, desc, id, visible, enabled, clickable)

    /** A Pixel-like keypad: ids key0..key9, the digit as text, letters in the description. */
    private val pixel = (0..9).map { key(text = "$it", desc = "$it,ABC", id = "com.android.systemui:id/key$it") } +
        key(id = "com.android.systemui:id/key_enter", desc = "Enter") +
        key(text = "Emergency call")

    private fun pin(s: String) = s.toCharArray()

    @Test fun pinRules() {
        assertNull(UnlockLogic.pinProblem(pin("1234")))
        assertNull(UnlockLogic.pinProblem(pin("1234567890123456")))
        assertEquals("too_short", UnlockLogic.pinProblem(pin("123")))
        assertEquals("too_long", UnlockLogic.pinProblem(pin("12345678901234567")))
        assertEquals("not_digits", UnlockLogic.pinProblem(pin("12a4")))
        assertEquals("not_digits", UnlockLogic.pinProblem(pin("١٢٣٤")))
    }

    @Test fun sameEntry() {
        assertTrue(UnlockLogic.sameEntry(pin("2580"), pin("2580")))
        assertFalse(UnlockLogic.sameEntry(pin("2580"), pin("2581")))
    }

    @Test fun mapsEveryDigitById() {
        val plan = UnlockLogic.plan(pin("2580"), pixel)!!
        assertEquals(listOf(2, 5, 8, 0), plan)
        assertEquals(10, UnlockLogic.enterKey(pixel))
    }

    @Test fun scrambledKeypadIsMatchedByLabelNotPlace() {
        val order = listOf(7, 3, 9, 0, 1, 8, 2, 6, 4, 5)
        val keys = order.map { key(text = "$it") }
        val plan = UnlockLogic.plan(pin("1234"), keys)!!
        assertEquals(listOf(order.indexOf(1), order.indexOf(2), order.indexOf(3), order.indexOf(4)), plan)
    }

    @Test fun descriptionFirstPartCounts() {
        val keys = (0..9).map { key(desc = "$it,ABC") }
        assertEquals(listOf(4, 3, 2, 1), UnlockLogic.plan(pin("4321"), keys))
    }

    @Test fun aMissingOrDoubledDigitRefusesTheWholePin() {
        val missing = pixel.filterNot { it.viewId?.endsWith("/key7") == true || it.text == "7" }
        assertNull(UnlockLogic.plan(pin("1279"), missing))
        val doubled = (0..9).map { key(text = "$it") } + key(text = "5")
        assertNull(UnlockLogic.plan(pin("1250"), doubled))
        val doubledId = pixel + key(id = "x:id/key3")
        assertNull(UnlockLogic.plan(pin("1234"), doubledId))
    }

    @Test fun hiddenOrDisabledKeysAreNotKeys() {
        val keys = (0..9).map { key(text = "$it", visible = it != 6) }
        assertNull(UnlockLogic.plan(pin("1600"), keys))
        val off = (0..9).map { key(text = "$it", enabled = it != 1) }
        assertNull(UnlockLogic.plan(pin("1000"), off))
    }

    @Test fun noKeypadAtAll() {
        assertNull(UnlockLogic.plan(pin("1234"), listOf(key(text = "12:00"), key(text = "Swipe up to unlock"))))
        assertNull(UnlockLogic.enterKey(listOf(key(text = "1"))))
    }

    @Test fun aTimeOnTheLockScreenIsNotADigit() {
        val keys = (0..9).map { key(text = "$it") } + key(text = "1 12")
        assertEquals(listOf(1, 2, 3, 4), UnlockLogic.plan(pin("1234"), keys))
    }

    /** ColorOS 14 (OnePlus PJE110), read on the phone: digits in the description only, no ids, no Enter. */
    @Test fun colorOsKeypad() {
        val keys = listOf(
            key(desc = "אזור קלט של סיסמה. הזנת 0 ספרות", clickable = false),
            key(id = "com.android.systemui:id/pinColorNumericKeyboard", clickable = false),
        ) + (1..9).map { key(desc = "$it") } + key(desc = "0") +
            key(text = "חירום SOS", id = "com.android.systemui:id/kgd_security_emergency_button")
        // Indexes: 2..10 are the keys 1..9, 11 is the key 0.
        assertEquals(listOf(2, 10, 11, 5), UnlockLogic.plan(pin("1904"), keys))
        assertNull(UnlockLogic.enterKey(keys))
    }

    @Test fun aClickableKeyWinsOverAClockDigit() {
        val keys = listOf(key(text = "9", id = "com.android.systemui:id/tv_hour", clickable = false)) +
            (0..9).map { key(desc = "$it") }
        // Index 0 is the clock; the key for digit d is at d + 1.
        assertEquals(listOf(10, 1, 1, 1), UnlockLogic.plan(pin("9000"), keys))
    }

    @Test fun decideNeedsEveryGate() {
        fun d(hasPin: Boolean = true, failed: Boolean = false, opted: String? = "h", hash: String = "h", sdk: Int = 34) =
            UnlockLogic.decide(hasPin, failed, opted, hash, sdk)
        assertEquals(UnlockLogic.Decision.PIN, d())
        assertEquals(UnlockLogic.Decision.ASK, d(hasPin = false))
        assertEquals(UnlockLogic.Decision.ASK, d(failed = true))
        assertEquals(UnlockLogic.Decision.ASK, d(opted = null))
        // Opted in with other steps: the edit turned it off.
        assertEquals(UnlockLogic.Decision.ASK, d(opted = "old"))
        assertEquals(UnlockLogic.Decision.ASK, d(sdk = 27))
    }
}
