package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The chat database's mode column (0.12). SQLite itself is Android's, so the statements are pinned here. */
class ChatSchemaTest {
    @Test fun `version 4 adds the mode, and every existing conversation is local`() {
        assertEquals(4, ChatSchema.VERSION)
        assertEquals(
            listOf("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'local'"),
            ChatSchema.conversationSteps(3),
        )
    }

    @Test fun `a table created fresh already has the mode, so it is not added twice`() {
        assertTrue(ChatSchema.CREATE_CONVERSATIONS.contains("mode       TEXT NOT NULL DEFAULT 'local'"))
        // Below 3 the upgrade creates the table from CREATE_CONVERSATIONS.
        assertEquals(emptyList<String>(), ChatSchema.conversationSteps(1))
        assertEquals(emptyList<String>(), ChatSchema.conversationSteps(2))
        assertEquals(emptyList<String>(), ChatSchema.conversationSteps(4))
    }

    @Test fun `a stored mode reads back as smart only when it says smart`() {
        assertEquals("smart", ChatSchema.modeOf("smart"))
        assertEquals("local", ChatSchema.modeOf("local"))
        assertEquals("local", ChatSchema.modeOf(null))
        assertEquals("local", ChatSchema.modeOf("SMART"))
    }
}
