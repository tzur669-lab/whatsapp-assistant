package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetLogicTest {
    private fun row(seq: Long, kind: String, text: String, private: Boolean = false) =
        Row(seq, kind, null, text, emptyList(), seq * 1_000, null, private)

    @Test fun `the newest reminder, and nothing else`() {
        val line = WidgetLogic.latest(listOf(row(1, "reminder", "ישן"), row(3, "reply", "תשובה"), row(2, "reminder", "חדש")))!!
        assertEquals("חדש", line.text)
        assertEquals(2_000, line.at)
        assertNull(WidgetLogic.latest(listOf(row(1, "digest", "תקציר"))))
    }

    @Test fun `a private reminder shows no text`() {
        val line = WidgetLogic.latest(listOf(row(5, "reminder", "לצאת ל־רופא", private = true)))!!
        assertNull(line.text)
    }

    @Test fun `one line, cut on a whole character`() {
        assertEquals("א ב", WidgetLogic.clip("א\nב"))
        val long = WidgetLogic.clip("😀".repeat(200))
        assertTrue(long.length <= WidgetLogic.MAX_CHARS)
        assertTrue(long.endsWith("…"))
    }

    @Test fun `an older row does not replace a newer one`() {
        assertTrue(WidgetLogic.replaces(WidgetLogic.Line("x", 10), 5))
        assertTrue(!WidgetLogic.replaces(WidgetLogic.Line("x", 4), 5))
    }
}
