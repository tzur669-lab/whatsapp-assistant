package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CardLogicTest {
    private val apps = listOf(
        CardLogic.App("Spotify", "com.spotify.music"),
        CardLogic.App("Waze", "com.waze"),
        CardLogic.App("WhatsApp", "com.whatsapp"),
        CardLogic.App("וואלה", "com.walla"),
        CardLogic.App("A", "com.a"),
    )

    @Test fun anExactLabelWins() {
        assertEquals(listOf("com.spotify.music"), CardLogic.matchApps(listOf("ספוטיפיי", "Spotify"), apps).map { it.packageName })
    }

    @Test fun caseAndPunctuationDoNotMatter() {
        assertEquals(listOf("com.waze"), CardLogic.matchApps(listOf("WAZE!"), apps).map { it.packageName })
    }

    @Test fun aLabelInsideTheWordsMatches() {
        assertEquals(listOf("com.waze"), CardLogic.matchApps(listOf("waze navigation"), apps).map { it.packageName })
    }

    @Test fun shortWordsNeverMatchByContainment() {
        assertTrue(CardLogic.matchApps(listOf("ap"), apps).isEmpty())
    }

    @Test fun nothingMatchesNothing() {
        assertTrue(CardLogic.matchApps(listOf("טלגרם"), apps).isEmpty())
    }

    @Test fun anIsraeliMobileGetsTheCountryCode() {
        assertEquals("972501234567", CardLogic.whatsAppNumber("050-123-4567"))
    }

    @Test fun anInternationalNumberKeepsItsCode() {
        assertEquals("972501234567", CardLogic.whatsAppNumber("+972 50 123 4567"))
        assertEquals("447700900123", CardLogic.whatsAppNumber("0044 7700 900123"))
    }

    @Test fun notANumberIsNull() {
        assertNull(CardLogic.whatsAppNumber("*100#"))
        assertNull(CardLogic.whatsAppNumber(""))
    }
}
