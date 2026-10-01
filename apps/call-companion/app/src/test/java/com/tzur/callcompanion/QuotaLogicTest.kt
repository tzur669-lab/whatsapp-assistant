package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Test

class QuotaLogicTest {
    @Test fun `numbers are grouped`() {
        assertEquals("200,000", QuotaLogic.number(200_000))
        assertEquals("940 מתוך 200,000", QuotaLogic.usedOf(200_000, 940))
    }

    @Test fun `bars turn amber at 70 percent and red at 90`() {
        assertEquals(QuotaLogic.OK, QuotaLogic.level(699, 1000))
        assertEquals(QuotaLogic.WARN, QuotaLogic.level(700, 1000))
        assertEquals(QuotaLogic.FULL, QuotaLogic.level(900, 1000))
        assertEquals(QuotaLogic.FULL, QuotaLogic.level(5, 0))
        assertEquals(1f, QuotaLogic.fraction(2_000, 1_000))
    }

    @Test fun `durations read the Hebrew way`() {
        assertEquals("פחות מדקה", QuotaLogic.duration(59_000))
        assertEquals("דקה", QuotaLogic.duration(60_000))
        assertEquals("12 דקות", QuotaLogic.duration(12 * 60_000L))
        assertEquals("שעה", QuotaLogic.duration(61 * 60_000L))
        assertEquals("שעתיים", QuotaLogic.duration(2 * 3_600_000L))
        assertEquals("5 שעות", QuotaLogic.duration(5 * 3_600_000L + 59 * 60_000L))
    }

    @Test fun `a reset and an age are measured on the report's clock`() {
        val at = 1_000_000_000L
        assertEquals("מתאפס בעוד 4 דקות", QuotaLogic.resetsIn(at + 4 * 60_000 + 10_000, at))
        assertEquals("התמלא מחדש", QuotaLogic.resetsIn(at - 1, at))
        assertEquals("עודכן עכשיו", QuotaLogic.age(at - 30_000, at))
        assertEquals("עודכן לפני 3 דקות", QuotaLogic.age(at - 3 * 60_000, at))
    }

    @Test fun `roles have Hebrew names`() {
        assertEquals("מודל ראשי", QuotaLogic.roleLabel("primary"))
        assertEquals("מודל גיבוי", QuotaLogic.roleLabel("fallback"))
        assertEquals("תמלול הקלטות", QuotaLogic.roleLabel("voice"))
    }
}
