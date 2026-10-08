package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatLogicTest {
    @Test fun `a bare slash offers every command`() {
        assertEquals(ChatLogic.COMMANDS.size, ChatLogic.commandsFor("/").size)
    }

    @Test fun `typing narrows the list`() {
        val usages = ChatLogic.commandsFor("/sh").map { it.usage }
        assertEquals(listOf("/shabbat", "/shabbat on", "/shabbat off"), usages)
        assertEquals(listOf("/shabbat off"), ChatLogic.commandsFor("/shabbat of").map { it.usage })
    }

    @Test fun `case does not matter`() {
        assertEquals(listOf("/status"), ChatLogic.commandsFor("/STA").map { it.usage })
    }

    @Test fun `ordinary text offers nothing`() {
        assertTrue(ChatLogic.commandsFor("").isEmpty())
        assertTrue(ChatLogic.commandsFor("תזכיר לי /help").isEmpty())
        assertTrue(ChatLogic.commandsFor("/help\nעוד שורה").isEmpty())
    }

    @Test fun `a command that takes an argument leaves room for it`() {
        val digest = ChatLogic.commandsFor("/digest").first { it.usage == "/digest <שעה>" }
        assertEquals("/digest ", digest.insert)
        // Typing the argument keeps it on the list.
        assertTrue(ChatLogic.commandsFor("/digest ").any { it.usage == "/digest <שעה>" })
    }

    @Test fun `every command is one the server's router knows`() {
        val known = Regex("^/(help|status|forget|digest|birthday|shabbat|ical|connect (google|gmail|tasks|drive)|city|pause|resume|ping|pair off)( |$)")
        for (command in ChatLogic.COMMANDS) assertTrue(command.insert, known.containsMatchIn(command.insert))
    }

    @Test fun `a conversation is named after its first line, shortened`() {
        assertEquals("תזכיר לי מחר", ChatLogic.titleFor("text", "  תזכיר לי מחר  \nועוד"))
        val long = "א".repeat(60)
        val title = ChatLogic.titleFor("text", long)
        assertEquals(40, title.length)
        assertTrue(title.endsWith("…"))
        assertEquals("הודעה קולית", ChatLogic.titleFor("voice", "‎0:05"))
        assertEquals("שיחה", ChatLogic.titleFor("text", "   "))
    }

    @Test fun `a row goes to the conversation of what it answers, else to reminders`() {
        val id = "11111111-1111-4111-8111-111111111111"
        assertEquals(id, ChatLogic.conversationForRow(id))
        assertEquals(ChatLogic.REMINDERS, ChatLogic.conversationForRow(null))
    }

    @Test fun `only a real conversation id is sent`() {
        val id = "11111111-1111-4111-8111-111111111111"
        assertEquals(id, ChatLogic.wireConversation(id))
        assertNull(ChatLogic.wireConversation(ChatLogic.REMINDERS))
        assertNull(ChatLogic.wireConversation(null))
    }

    @Test fun `shared text joins its subject, and is capped on a whole character`() {
        assertEquals("פגישה\nמחר ב־9", ChatLogic.sharedOf("  מחר ב־9 ", "פגישה"))
        assertEquals("פגישה מחר", ChatLogic.sharedOf("פגישה מחר", "פגישה"))
        assertEquals("נושא", ChatLogic.sharedOf("", "נושא"))
        assertNull(ChatLogic.sharedOf("  ", null))
        assertNull(ChatLogic.sharedOf(null, null))
        assertEquals(Protocol.MAX_SHARED_CHARS, ChatLogic.sharedOf("א".repeat(5_000), null)!!.length)
        // An emoji is two chars: it is never cut in half.
        val emoji = "😀".repeat(Protocol.MAX_SHARED_CHARS)
        val capped = ChatLogic.sharedOf(emoji, null)!!
        assertTrue(capped.length <= Protocol.MAX_SHARED_CHARS)
        assertTrue(!Character.isHighSurrogate(capped.last()))
    }

    @Test fun `a command cannot carry shared text`() {
        assertTrue(ChatLogic.canSendWithShared("תזכיר לי"))
        assertTrue(!ChatLogic.canSendWithShared(" /pause"))
        assertEquals("מה זה?\n\n«טקסט»", ChatLogic.sharedDisplay("מה זה?", "טקסט"))
    }

    @Test fun `a conversation's stored mode wins, then the one chosen before its first message, then local`() {
        val id = "11111111-1111-4111-8111-111111111111"
        assertEquals(Protocol.MODE_SMART, ChatLogic.modeFor(id, stored = "smart", chosen = "local"))
        assertEquals(Protocol.MODE_LOCAL, ChatLogic.modeFor(id, stored = "local", chosen = "smart"))
        assertEquals(Protocol.MODE_SMART, ChatLogic.modeFor(id, stored = null, chosen = "smart"))
        assertEquals(Protocol.MODE_LOCAL, ChatLogic.modeFor(id, stored = null, chosen = null))
        assertEquals(Protocol.MODE_LOCAL, ChatLogic.modeFor(id, stored = "garbage", chosen = null))
        // Reminders is no conversation on the wire: no mode.
        assertNull(ChatLogic.modeFor(ChatLogic.REMINDERS, stored = null, chosen = "smart"))
    }

    @Test fun `smart can be chosen only when the server said it can run one`() {
        assertTrue(ChatLogic.smartSelectable(true))
        assertTrue(!ChatLogic.smartSelectable(false))
        assertTrue(!ChatLogic.smartSelectable(null))
    }

    @Test fun `a 422 mode mismatch is its own message and is not sent again`() {
        assertEquals(ChatLogic.Refusal.MODE_MISMATCH, ChatLogic.refusalOf(422, "mode_mismatch"))
        assertTrue(!ChatLogic.retriesAfterRefusal(422))
        assertEquals(ChatLogic.Refusal.REFUSED, ChatLogic.refusalOf(422, "other"))
        assertEquals(ChatLogic.Refusal.NOT_AVAILABLE, ChatLogic.refusalOf(404, "not_found"))
        assertEquals(ChatLogic.Refusal.TOO_LARGE, ChatLogic.refusalOf(413, null))
        assertEquals(ChatLogic.Refusal.REFUSED, ChatLogic.refusalOf(400, "bad_request"))
        // Only a server failure is asked about again, with the same id.
        assertTrue(ChatLogic.retriesAfterRefusal(500))
        assertTrue(ChatLogic.retriesAfterRefusal(503))
    }
}
