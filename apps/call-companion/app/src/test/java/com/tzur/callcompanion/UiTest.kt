package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Test

class UiTest {
    private val fsi = Char(0x2068)
    private val pdi = Char(0x2069)

    @Test fun `a URL wrapped in isolates loses them, the rest of the text keeps its own`() {
        val id = "a".repeat(64)
        val url = "https://wa-assistant-staging.example.dev/oauth/google/start?id=$id"
        val text = "לחיבור יומן:\n$fsi$url$pdi\n\nתקף $fsi" + "10" + "$pdi דקות."
        assertEquals("לחיבור יומן:\n$url\n\nתקף $fsi" + "10" + "$pdi דקות.", Ui.cleanLinks(text))
    }

    @Test fun `text without a URL is untouched`() {
        val text = "תקף $fsi" + "10" + "$pdi דקות."
        assertEquals(text, Ui.cleanLinks(text))
    }
}
