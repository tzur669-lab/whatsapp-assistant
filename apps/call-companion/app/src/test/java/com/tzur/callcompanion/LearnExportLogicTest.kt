package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date
import java.util.TimeZone

class LearnExportLogicTest {
    @Test fun `the file name carries the local date`() {
        val zone = TimeZone.getTimeZone("Asia/Jerusalem")
        // 2026-10-14 22:30 UTC is already the 15th in Jerusalem.
        val at = java.util.GregorianCalendar(TimeZone.getTimeZone("UTC")).apply { clear(); set(2026, 9, 14, 22, 30) }.time
        assertEquals("bot-learn-2026-10-15.json", LearnExportLogic.fileName(at, zone))
        assertEquals("bot-learn-2026-10-14.json", LearnExportLogic.fileName(at, TimeZone.getTimeZone("UTC")))
    }

    @Test fun `only a JSON object with a schema is an export`() {
        assertTrue(LearnExportLogic.isExport("{\"schema\":1,\"pairs\":[]}"))
        assertFalse(LearnExportLogic.isExport("{\"pairs\":[]}"))
        assertFalse(LearnExportLogic.isExport("[1]"))
        assertFalse(LearnExportLogic.isExport("not json"))
        assertFalse(LearnExportLogic.isExport(null))
    }

    @Test fun `the route is signed with an empty body`() {
        assertEquals("/app/learn/export", LearnExportLogic.PATH)
    }
}
