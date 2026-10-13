package com.tzur.callcompanion

import java.security.MessageDigest
import java.util.Locale

/**
 * Event-triggered reminders' words and queue (0.15, PLAN §6.30). Pure: no
 * Android, tested on the JVM.
 *
 * The normalization and the match rule are kept twice, here and in the
 * server's `src/core/watch-match.ts`; both are checked against
 * `test/fixtures/watch-normalize.json` ([WatchMatcherFixtureTest]). The server
 * sends the keywords already normalized; the phone matches, and no text of a
 * notification or SMS ever leaves it — only the watch's id goes out.
 */
object WatchMatcher {
    data class Watch(val id: String, val source: String, val keywords: List<String>, val expiresAt: Long)

    private val MARKS = Regex("[\\u0591-\\u05C7]")
    private val QUOTES = Regex("[\\u05F3\\u05F4'\"`]")
    private val NOT_WORD = Regex("[^\\p{L}\\p{N}]+")
    private val HEBREW_PREFIX = Regex("^[והבכלמש]{1,4}$")
    private val HEBREW = Regex("[\\u05D0-\\u05EA]")
    private val FINALS = mapOf('ך' to 'כ', 'ם' to 'מ', 'ן' to 'נ', 'ף' to 'פ', 'ץ' to 'צ')
    val ID = Regex("^[0-9a-f]{32}$")

    fun normalize(text: String): String {
        val lowered = text.lowercase(Locale.ROOT).replace(MARKS, "").replace(QUOTES, "")
        val folded = buildString(lowered.length) { for (c in lowered) append(FINALS[c] ?: c) }
        return folded.replace(NOT_WORD, " ").trim()
    }

    private fun wordMatches(word: String, wanted: String): Boolean {
        if (word == wanted) return true
        if (!HEBREW.containsMatchIn(wanted) || !word.endsWith(wanted)) return false
        return HEBREW_PREFIX.matches(word.substring(0, word.length - wanted.length))
    }

    /** Every keyword's every word is in the text, as a whole word or behind Hebrew prefix letters. */
    fun matches(text: String, keywords: List<String>): Boolean {
        val words = normalize(text).split(' ').filter { it.isNotEmpty() }
        val wanted = keywords.flatMap { it.split(' ') }.filter { it.isNotEmpty() }
        if (wanted.isEmpty()) return false
        return wanted.all { target -> words.any { wordMatches(it, target) } }
    }

    /** The watches of one source whose keywords this text holds, unexpired. */
    fun matching(watches: List<Watch>, source: String, text: String, now: Long): List<Watch> =
        watches.filter { it.source == source && it.expiresAt > now && matches(text, it.keywords) }

    /**
     * A notification's identity: its key and a local hash of its title and
     * text, so an update with new text is a new event and a repeated callback
     * is not. Stored only as this hash; never sent.
     */
    fun notificationEvent(key: String, title: String?, text: String?): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("${title.orEmpty()}\u0000${text.orEmpty()}".toByteArray(Charsets.UTF_8))
        val hex = digest.joinToString("") { "%02x".format(it) }.take(16)
        return "n:$key:$hex"
    }

    /** An SMS's identity: the provider's own `_id`. */
    fun smsEvent(id: Long): String = "s:$id"

    // -- the queue -------------------------------------------------------------

    /** A match not yet answered 2xx: ids and times only. */
    data class Pending(val watchId: String, val eventId: String, val matchedAt: Long)

    const val MAX_PENDING = 20
    const val MAX_HANDLED = 100
    const val STALE_MS = 10 * 60 * 1000L

    /** The queue with one more match: new keys only, never one already handled; at capacity stale first, then the oldest. */
    fun enqueue(queue: List<Pending>, handled: List<String>, entry: Pending, now: Long): List<Pending> {
        val key = handledKey(entry.watchId, entry.eventId)
        if (key in handled || queue.any { handledKey(it.watchId, it.eventId) == key }) return queue
        var next = (queue + entry).filter { now - it.matchedAt <= STALE_MS }
        while (next.size > MAX_PENDING) {
            val oldest = next.minWith(compareBy<Pending> { it.matchedAt }.thenBy { it.watchId }.thenBy { it.eventId })
            next = next - oldest
        }
        return next
    }

    /** What may still be sent: fresh entries, oldest first. Stale ones are dropped: the server would refuse them. */
    fun sendable(queue: List<Pending>, now: Long): List<Pending> =
        queue.filter { now - it.matchedAt <= STALE_MS }.sortedBy { it.matchedAt }

    fun handledKey(watchId: String, eventId: String) = "$watchId|$eventId"

    /** The handled list with one more key, the newest [MAX_HANDLED] kept. */
    fun markHandled(handled: List<String>, key: String): List<String> =
        if (key in handled) handled else (handled + key).takeLast(MAX_HANDLED)
}
