package com.tzur.callcompanion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Event-triggered reminders on the phone (0.15, PLAN §6.30): the watch list
 * from the server, matched here against notifications and SMS. A match sends
 * only the watch's id and when it was seen; the text never leaves the phone.
 *
 * Stored in `SharedPreferences` (ids, normalized keywords, times; no message
 * text): the list, the events already answered 2xx (the last 100), and the
 * matches still waiting for a 2xx (at most 20, dropped after 10 minutes).
 * Network work runs on one background thread, never the listener's.
 */
object Watches {
    private const val PREFS = "watches"
    private const val KEY_LIST = "list"
    private const val KEY_HANDLED = "handled"
    private const val KEY_PENDING = "pending"

    private val worker = Executors.newSingleThreadExecutor()
    private val lock = Any()

    /** Fetch the list again (app start, an FCM `watches` push), then send what waits. */
    fun refresh(context: Context) {
        val app = context.applicationContext
        worker.execute {
            val fetched = Api.fetchWatches(app) ?: return@execute
            synchronized(lock) { prefs(app).edit().putString(KEY_LIST, listJson(fetched)).commit() }
            flushNow(app)
        }
    }

    /** Send the matches still waiting (connectivity back, app start). */
    fun flush(context: Context) {
        val app = context.applicationContext
        worker.execute { flushNow(app) }
    }

    /**
     * A notification was posted (already past the collector's hidden-app
     * check). From the default SMS app: the newest SMS is matched against
     * `sms` watches; from any other app: its title and text against
     * `notification` watches. One SMS can never fire both kinds.
     */
    fun onNotification(context: Context, packageName: String, key: String, title: String?, text: String?) {
        val app = context.applicationContext
        val watches = list(app)
        if (watches.isEmpty()) return
        val now = System.currentTimeMillis()
        val smsApp = Telephony.Sms.getDefaultSmsPackage(app)
        if (packageName == smsApp) {
            if (watches.none { it.source == "sms" }) return
            worker.execute {
                val (id, body) = newestSms(app) ?: return@execute
                val hits = WatchMatcher.matching(watches, "sms", body, now)
                if (hits.isNotEmpty()) record(app, hits.map { WatchMatcher.Pending(it.id, WatchMatcher.smsEvent(id), now) })
            }
            return
        }
        val hits = WatchMatcher.matching(watches, "notification", "${title.orEmpty()} ${text.orEmpty()}", now)
        if (hits.isEmpty()) return
        val event = WatchMatcher.notificationEvent(key, title, text)
        worker.execute { record(app, hits.map { WatchMatcher.Pending(it.id, event, now) }) }
    }

    private fun record(context: Context, entries: List<WatchMatcher.Pending>) {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            var queue = pending(context)
            val handled = handled(context)
            for (entry in entries) queue = WatchMatcher.enqueue(queue, handled, entry, now)
            prefs(context).edit().putString(KEY_PENDING, pendingJson(queue)).commit()
        }
        flushNow(context)
    }

    /** Each waiting match, oldest first: a 2xx marks it handled; anything else keeps it for the next try. */
    private fun flushNow(context: Context) {
        val now = System.currentTimeMillis()
        val waiting = synchronized(lock) { WatchMatcher.sendable(pending(context), now) }
        for (entry in waiting) {
            if (!Api.watchFired(context, entry.watchId, entry.matchedAt)) continue
            synchronized(lock) {
                val key = WatchMatcher.handledKey(entry.watchId, entry.eventId)
                val queue = pending(context).filterNot { WatchMatcher.handledKey(it.watchId, it.eventId) == key }
                prefs(context).edit()
                    .putString(KEY_PENDING, pendingJson(queue))
                    .putString(KEY_HANDLED, JSONArray(WatchMatcher.markHandled(handled(context), key)).toString())
                    .commit()
            }
        }
        // What went stale is dropped: the server would refuse it.
        synchronized(lock) {
            val fresh = WatchMatcher.sendable(pending(context), System.currentTimeMillis())
            prefs(context).edit().putString(KEY_PENDING, pendingJson(fresh)).commit()
        }
    }

    /** The newest inbox SMS's `_id` and text, through the existing `READ_SMS` grant; null without it. */
    private fun newestSms(context: Context): Pair<Long, String>? {
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return null
        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms._ID, Telephony.Sms.BODY),
            null,
            null,
            "${Telephony.Sms.DATE} DESC",
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            val body = cursor.getString(1) ?: return null
            return cursor.getLong(0) to body
        }
        return null
    }

    // -- storage ---------------------------------------------------------------

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun list(context: Context): List<WatchMatcher.Watch> = synchronized(lock) {
        parseList(prefs(context).getString(KEY_LIST, null) ?: return emptyList())
    }

    private fun handled(context: Context): List<String> {
        val raw = prefs(context).getString(KEY_HANDLED, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map { array.getString(it) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun pending(context: Context): List<WatchMatcher.Pending> {
        val raw = prefs(context).getString(KEY_PENDING, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map {
                val o = array.getJSONObject(it)
                WatchMatcher.Pending(o.getString("w"), o.getString("e"), o.getLong("t"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun pendingJson(queue: List<WatchMatcher.Pending>): String =
        JSONArray(queue.map { JSONObject().put("w", it.watchId).put("e", it.eventId).put("t", it.matchedAt) }).toString()

    private fun listJson(watches: List<WatchMatcher.Watch>): String =
        JSONArray(
            watches.map {
                JSONObject().put("id", it.id).put("source", it.source).put("keywords", JSONArray(it.keywords)).put("expiresAt", it.expiresAt)
            },
        ).toString()

    /** The server's list (or the stored one): only well-formed entries of the two phone sources. */
    fun parseList(raw: String): List<WatchMatcher.Watch> = try {
        val array = if (raw.trimStart().startsWith("{")) JSONObject(raw).getJSONArray("watches") else JSONArray(raw)
        (0 until array.length()).mapNotNull {
            val o = array.getJSONObject(it)
            val id = o.optString("id")
            val source = o.optString("source")
            val keywords = o.optJSONArray("keywords") ?: return@mapNotNull null
            if (!WatchMatcher.ID.matches(id) || source !in setOf("notification", "sms")) return@mapNotNull null
            WatchMatcher.Watch(id, source, (0 until keywords.length()).map { k -> keywords.getString(k) }, o.optLong("expiresAt"))
        }
    } catch (_: Exception) {
        emptyList()
    }
}
