package com.tzur.callcompanion

import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Build
import android.provider.Settings
import android.app.NotificationManager

/**
 * The last day of notifications, kept on this phone only (PLAN §6.21).
 *
 * Android does not let an app read notifications that came before it was
 * listening, so [NotificationCollector] writes what arrives here, and a phone
 * read answers from it. The database is private and excluded from backup and
 * device transfer like the chat's. Rows older than a day go on every write; a
 * notification updated in place (a chat that keeps growing) replaces its row.
 *
 * What is never written: this app's own notifications, ongoing ones, group
 * summaries, anything carrying a one-time code, and every app the user hid.
 */
class NotificationBuffer private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "notifications.db", null, 1) {

    class Entry(val app: String, val title: String?, val text: String?, val postedAt: Long)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE notifications (
              key        TEXT PRIMARY KEY,
              package    TEXT NOT NULL,
              app        TEXT NOT NULL,
              title      TEXT,
              text       TEXT,
              posted_at  INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX notifications_posted ON notifications (posted_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun add(key: String, packageName: String, app: String, title: String?, text: String?, postedAt: Long) {
        val db = writableDatabase
        db.insertWithOnConflict("notifications", null, ContentValues().apply {
            put("key", key)
            put("package", packageName)
            put("app", PhoneReadLogic.cut(app, PhoneReadLogic.MAX_APP))
            put("title", title?.let { PhoneReadLogic.cut(it, PhoneReadLogic.MAX_TITLE) })
            put("text", text?.let { PhoneReadLogic.cut(it, PhoneReadLogic.MAX_TEXT) })
            put("posted_at", postedAt)
        }, SQLiteDatabase.CONFLICT_REPLACE)
        purge(postedAt)
    }

    /** Newest first, since a time, optionally from one app named in words. */
    fun since(sinceMs: Long, app: String?): List<Entry> {
        purge(System.currentTimeMillis())
        val out = mutableListOf<Entry>()
        readableDatabase.query(
            "notifications",
            arrayOf("app", "title", "text", "posted_at"),
            "posted_at >= ?",
            arrayOf(sinceMs.toString()),
            null,
            null,
            "posted_at DESC",
            "200",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val entry = Entry(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getLong(3))
                if (PhoneReadLogic.nameMatches(entry.app, app)) out += entry
                if (out.size >= PhoneReadLogic.MAX_ITEMS) break
            }
        }
        return out
    }

    /** The apps seen in the last day, by package, with their labels — for the hide list. */
    fun seenApps(): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        readableDatabase.rawQuery("SELECT package, MAX(app) FROM notifications GROUP BY package ORDER BY 2", null).use { cursor ->
            while (cursor.moveToNext()) out += cursor.getString(0) to cursor.getString(1)
        }
        return out
    }

    fun forgetPackage(packageName: String) {
        writableDatabase.delete("notifications", "package = ?", arrayOf(packageName))
    }

    private fun purge(now: Long) {
        writableDatabase.delete("notifications", "posted_at < ?", arrayOf((now - DAY_MS).toString()))
    }

    companion object {
        private const val DAY_MS = 24 * 60 * 60 * 1000L
        private const val PREFS = "phone_reads"
        private const val HIDDEN = "hidden_packages"

        @Volatile private var instance: NotificationBuffer? = null

        fun get(context: Context): NotificationBuffer =
            instance ?: synchronized(this) { instance ?: NotificationBuffer(context).also { instance = it } }

        /** The user turned notification access on for this app. */
        fun isEnabled(context: Context): Boolean {
            val component = ComponentName(context, NotificationCollector::class.java)
            if (Build.VERSION.SDK_INT >= 27) {
                return context.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(component)
            }
            val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
            return enabled.split(':').any { it == component.flattenToString() }
        }

        fun hidden(context: Context): Set<String> =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(HIDDEN, emptySet()) ?: emptySet()

        /** Hidden apps are not written down, and what was kept of them goes now. */
        fun setHidden(context: Context, packages: Set<String>) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(HIDDEN, packages.toSet()).apply()
            val buffer = get(context)
            for (packageName in packages) buffer.forgetPackage(packageName)
        }
    }
}
