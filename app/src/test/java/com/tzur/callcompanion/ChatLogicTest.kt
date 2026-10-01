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
        val known = Regex("^/(help|status|forget|digest|birthday|shabbat|ical|connect google|pause|resume|ping|pair off)( |$)")
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
}
