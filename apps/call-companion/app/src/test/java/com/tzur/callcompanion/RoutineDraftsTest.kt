package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Kind
import com.tzur.callcompanion.RoutineLogic.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineDraftsTest {
    private var now = 1_000L
    private val drafts = RoutineDrafts { now }
    private val steps = listOf(Step(Kind.TAP_TEXT, "חיפוש"), Step(Kind.TYPE_TEXT, "סטימצקי"))

    @Test fun aDraftLivesThirtyMinutes() {
        val id = drafts.offer("com.example.fid", "FID", steps, setOf(1))
        now += RoutineDrafts.TTL_MS - 1
        assertEquals(steps, drafts.get(id)?.steps)
        assertEquals(setOf(1), drafts.current()?.marked)
        now += 1
        assertNull(drafts.get(id))
        assertNull(drafts.current())
        assertNull(drafts.take(id))
    }

    @Test fun aNewerDraftReplacesTheOldAndItsIdGoesStale() {
        val old = drafts.offer("com.example.fid", "FID", steps, emptySet())
        val new = drafts.offer("com.example.other", "Other", steps.take(1), emptySet())
        assertNull(drafts.get(old))
        assertFalse(drafts.update(old, steps, emptySet()))
        drafts.drop(old)
        assertNull(drafts.take(old))
        assertEquals("com.example.other", drafts.get(new)?.packageName)
    }

    @Test fun updateKeepsTheWorkingCopyAndTheClock() {
        val id = drafts.offer("com.example.fid", "FID", steps, setOf(1))
        now += 10 * 60_000L
        assertTrue(drafts.update(id, steps.take(1), emptySet()))
        assertEquals(steps.take(1), drafts.get(id)?.steps)
        now += 20 * 60_000L
        assertNull("an edit does not extend the draft's life", drafts.get(id))
    }

    @Test fun takeAndDropActOnlyOnce() {
        val id = drafts.offer("com.example.fid", "FID", steps, emptySet())
        assertNotNull(drafts.take(id))
        assertNull(drafts.take(id))

        val other = drafts.offer("com.example.fid", "FID", steps, emptySet())
        drafts.drop("stale")
        assertNotNull(drafts.get(other))
        drafts.drop(other)
        assertNull(drafts.current())
    }
}
