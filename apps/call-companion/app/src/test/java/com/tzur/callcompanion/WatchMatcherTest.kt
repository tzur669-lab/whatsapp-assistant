package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Watches on the phone (0.15, PLAN §6.30): the words match the server's
 * (`test/fixtures/watch-normalize.json`, skipped in a lone app checkout), an
 * event's identity, and the queue of matches waiting for a 2xx.
 */
class WatchMatcherTest {

    @Suppress("UNCHECKED_CAST")
    private fun fixture(): Map<String, Any?>? {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .take(6)
            .map { File(it, "test/fixtures/watch-normalize.json") }
            .firstOrNull { it.isFile } ?: return null
        return MiniJson.parse(file.readText(Charsets.UTF_8)) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    @Test fun `normalizes and matches exactly as the shared file says`() {
        val file = fixture()
        assumeTrue("the shared fixture is not in this checkout", file != null)
        for (pair in file!!["normalize"] as List<List<String>>) {
            assertEquals(pair[0], pair[1], WatchMatcher.normalize(pair[0]))
        }
        for (case in file["match"] as List<List<Any?>>) {
            val text = case[0] as String
            val keywords = case[1] as List<String>
            assertEquals("$text $keywords", case[2] as Boolean, WatchMatcher.matches(text, keywords))
        }
    }

    private val now = 1_000_000_000L
    private val id = "a".repeat(32)
    private val other = "b".repeat(32)

    @Test fun `matching keeps the source and the end`() {
        val watches = listOf(
            WatchMatcher.Watch(id, "notification", listOf("חבילה"), now + 1),
            WatchMatcher.Watch(other, "sms", listOf("חבילה"), now + 1),
            WatchMatcher.Watch("c".repeat(32), "notification", listOf("חבילה"), now),
        )
        assertEquals(listOf(id), WatchMatcher.matching(watches, "notification", "החבילה הגיעה", now).map { it.id })
        assertEquals(listOf(other), WatchMatcher.matching(watches, "sms", "החבילה הגיעה", now).map { it.id })
    }

    @Test fun `a notification whose text changes is a new event, the same text is not`() {
        val first = WatchMatcher.notificationEvent("k", "בנק", "חבילה 1")
        assertEquals(first, WatchMatcher.notificationEvent("k", "בנק", "חבילה 1"))
        assertNotEquals(first, WatchMatcher.notificationEvent("k", "בנק", "חבילה 2"))
        assertFalse("no text in the id", first.contains("חבילה"))
        assertNotEquals(WatchMatcher.smsEvent(1), WatchMatcher.smsEvent(2))
    }

    private fun pending(watch: String, event: String, at: Long) = WatchMatcher.Pending(watch, event, at)

    @Test fun `a repeat while pending adds no copy, and a handled one is never queued`() {
        var queue = WatchMatcher.enqueue(emptyList(), emptyList(), pending(id, "s:1", now), now)
        queue = WatchMatcher.enqueue(queue, emptyList(), pending(id, "s:1", now + 5), now + 5)
        assertEquals(1, queue.size)
        val handled = WatchMatcher.markHandled(emptyList(), WatchMatcher.handledKey(id, "s:2"))
        assertEquals(queue, WatchMatcher.enqueue(queue, handled, pending(id, "s:2", now), now))
        // Two different SMS on one notification key are two events.
        assertEquals(2, WatchMatcher.enqueue(queue, emptyList(), pending(id, "s:3", now), now).size)
    }

    @Test fun `at capacity stale entries go first, then the smallest matchedAt, whatever the order of arrival`() {
        val base = now + WatchMatcher.STALE_MS
        var queue = listOf(pending(other, "old", now - 1)) // stale by `base`
        for (i in 1 until WatchMatcher.MAX_PENDING) queue = queue + pending(id, "e$i", base + i * 10)
        queue = WatchMatcher.enqueue(queue, emptyList(), pending(id, "new", base + 5), base)
        assertEquals(WatchMatcher.MAX_PENDING, queue.size)
        assertFalse(queue.any { it.eventId == "old" })
        // Full of fresh ones: the smallest matchedAt goes, even though it arrived last.
        val full = WatchMatcher.enqueue(queue, emptyList(), pending(id, "later", base + 1_000), base)
        assertEquals(WatchMatcher.MAX_PENDING, full.size)
        assertFalse(full.any { it.eventId == "new" })
        assertTrue(full.any { it.eventId == "later" })
    }

    @Test fun `only fresh entries are sent, oldest first`() {
        val queue = listOf(pending(id, "b", now + 20), pending(id, "a", now + 10), pending(id, "x", now - WatchMatcher.STALE_MS - 1))
        assertEquals(listOf("a", "b"), WatchMatcher.sendable(queue, now + 30).map { it.eventId })
    }

    @Test fun `handled keeps the newest hundred`() {
        var handled = emptyList<String>()
        for (i in 0..100) handled = WatchMatcher.markHandled(handled, "k$i")
        assertEquals(WatchMatcher.MAX_HANDLED, handled.size)
        assertFalse("k0" in handled)
        assertTrue("k100" in handled)
    }
}
