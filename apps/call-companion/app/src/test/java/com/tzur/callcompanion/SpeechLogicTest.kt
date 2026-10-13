package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spoken replies (0.16, block J, J6): when, once, and the one order. */
class SpeechLogicTest {
    private fun speak(
        enabled: Boolean = true,
        kind: String? = "voice",
        viaPush: Boolean = false,
        ringerNormal: Boolean = true,
        spoken: List<String> = emptyList(),
        id: String = "r:1",
    ) = SpeechLogic.shouldSpeak(enabled, kind, viaPush, ringerNormal, spoken, id)

    @Test fun `only the direct answer to a voice note, with the setting on and the ringer normal`() {
        assertTrue(speak())
        assertFalse("off by default", speak(enabled = false))
        assertFalse("a typed message", speak(kind = "text"))
        assertFalse("no such outgoing message", speak(kind = null))
        assertFalse("a push", speak(viaPush = true))
        assertFalse("silent or vibrate", speak(ringerNormal = false))
    }

    @Test fun `a reply is spoken once, and the 51st evicts the oldest`() {
        var spoken = SpeechLogic.markSpoken(emptyList(), "r:1")
        assertFalse(speak(spoken = spoken, id = "r:1"))
        assertEquals(spoken, SpeechLogic.markSpoken(spoken, "r:1"))
        for (i in 2..51) spoken = SpeechLogic.markSpoken(spoken, "r:$i")
        assertEquals(SpeechLogic.MAX_SPOKEN, spoken.size)
        assertFalse("r:1" in spoken)
        assertTrue("r:51" in spoken)
    }

    @Test fun `the order - no engine or no Hebrew voice speaks nothing and marks nothing`() {
        assertEquals(SpeechLogic.Step.NOT_READY, SpeechLogic.step(engineReady = false, hebrewAvailable = true))
        assertEquals(SpeechLogic.Step.NO_HEBREW, SpeechLogic.step(engineReady = true, hebrewAvailable = false))
        assertEquals(SpeechLogic.Step.SPEAK, SpeechLogic.step(engineReady = true, hebrewAvailable = true))
    }
}
