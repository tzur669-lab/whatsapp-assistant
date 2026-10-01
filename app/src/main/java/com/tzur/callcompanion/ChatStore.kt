package com.tzur.callcompanion

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * The chat history. It lives only on this phone, in the app's private
 * database, excluded from backup and device transfer
 * (`data_extraction_rules.xml`). The server keeps nothing it has delivered.
 *
 * A server row is stored under its `seq`, which is UNIQUE: the first write
 * wins and a second fetch of the same row is ignored, so a push, a poll and
 * the response to a message can all deliver it without a duplicate. The order
 * on screen is arrival order; each row keeps the time the server wrote it.
 */
class ChatStore private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "chat.db", null, 1) {

    class Message(
        val localId: Long,
        val seq: Long?,
        val outgoing: Boolean,
        /** Outgoing: the client message id. Incoming: the message it answers. */
        val messageId: String?,
        val kind: String,
        val text: String,
        val buttons: List<Row.Button>,
        val answered: Boolean,
        val state: Int,
        val createdAt: Long,
        val arrivedAt: Long,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE messages (
              local_id   INTEGER PRIMARY KEY AUTOINCREMENT,
              seq        INTEGER UNIQUE,
              outgoing   INTEGER NOT NULL,
              message_id TEXT,
              kind       TEXT NOT NULL,
              text       TEXT NOT NULL,
              buttons    TEXT,
              answered   INTEGER NOT NULL DEFAULT 0,
              state      INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              arrived_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX messages_message_id ON messages (message_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /** What the user typed, said or tapped, before it is sent. */
    fun addOutgoing(messageId: String, kind: String, text: String) {
        val now = System.currentTimeMillis()
        writableDatabase.insert("messages", null, ContentValues().apply {
            put("outgoing", 1)
            put("message_id", messageId)
            put("kind", kind)
            put("text", text)
            put("state", STATE_SENDING)
            put("created_at", now)
            put("arrived_at", now)
        })
        trim()
    }

    fun setState(messageId: String, state: Int) {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("state", state) },
            "outgoing = 1 AND message_id = ?",
            arrayOf(messageId),
        )
    }

    /**
     * Store rows from the server in one transaction. Returns the ones that
     * were new — the ones to announce. Every row with a seq is stored once this
     * returns, new or not, so all of them may be acked.
     */
    fun saveRows(rows: List<Row>): List<Row> {
        val fresh = mutableListOf<Row>()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val now = System.currentTimeMillis()
            for (row in rows) {
                val values = ContentValues().apply {
                    if (row.seq > 0) put("seq", row.seq) else putNull("seq")
                    put("outgoing", 0)
                    put("message_id", row.inReplyTo)
                    put("kind", row.kind)
                    put("text", row.text)
                    put("buttons", buttonsJson(row.buttons))
                    put("created_at", row.createdAt)
                    put("arrived_at", now)
                }
                val id = db.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_IGNORE)
                if (id != -1L) fresh += row
                // An answer is proof the message arrived, whatever the request said.
                if (row.inReplyTo != null) {
                    db.update(
                        "messages",
                        ContentValues().apply { put("state", STATE_SENT) },
                        "outgoing = 1 AND message_id = ?",
                        arrayOf(row.inReplyTo),
                    )
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        if (fresh.isNotEmpty()) trim()
        return fresh
    }

    /**
     * A line from the app itself — "no connection" and the like. Never sent
     * anywhere, and answers nothing: it must not mark a message as arrived.
     */
    fun addNotice(text: String) {
        saveRows(listOf(Row(0, "notice", null, text, emptyList(), System.currentTimeMillis())))
    }

    fun hasReplyTo(messageId: String): Boolean =
        readableDatabase.rawQuery(
            "SELECT 1 FROM messages WHERE outgoing = 0 AND message_id = ? LIMIT 1",
            arrayOf(messageId),
        ).use { it.moveToFirst() }

    /** A button under this row was tapped. Its buttons stay visible but inactive. */
    fun markAnswered(seq: Long) {
        writableDatabase.update("messages", ContentValues().apply { put("answered", 1) }, "seq = ?", arrayOf(seq.toString()))
    }

    /** A process that died mid-send left these. Whether they arrived is not known here. */
    fun failStale() {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("state", STATE_FAILED) },
            "outgoing = 1 AND state = ?",
            arrayOf(STATE_SENDING.toString()),
        )
    }

    fun all(): List<Message> =
        readableDatabase.rawQuery("SELECT * FROM messages ORDER BY local_id", null).use { cursor ->
            val out = ArrayList<Message>(cursor.count)
            while (cursor.moveToNext()) out += message(cursor)
            out
        }

    private fun trim() {
        writableDatabase.execSQL(
            "DELETE FROM messages WHERE local_id NOT IN (SELECT local_id FROM messages ORDER BY local_id DESC LIMIT $KEEP)",
        )
    }

    private fun message(c: Cursor): Message = Message(
        localId = c.getLong(c.getColumnIndexOrThrow("local_id")),
        seq = c.getColumnIndexOrThrow("seq").let { if (c.isNull(it)) null else c.getLong(it) },
        outgoing = c.getInt(c.getColumnIndexOrThrow("outgoing")) == 1,
        messageId = c.getString(c.getColumnIndexOrThrow("message_id")),
        kind = c.getString(c.getColumnIndexOrThrow("kind")),
        text = c.getString(c.getColumnIndexOrThrow("text")),
        buttons = parseButtons(c.getString(c.getColumnIndexOrThrow("buttons"))),
        answered = c.getInt(c.getColumnIndexOrThrow("answered")) == 1,
        state = c.getInt(c.getColumnIndexOrThrow("state")),
        createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
        arrivedAt = c.getLong(c.getColumnIndexOrThrow("arrived_at")),
    )

    private fun buttonsJson(buttons: List<Row.Button>): String? {
        if (buttons.isEmpty()) return null
        val array = JSONArray()
        for (b in buttons) array.put(JSONObject().put("id", b.id).put("title", b.title))
        return array.toString()
    }

    private fun parseButtons(json: String?): List<Row.Button> {
        if (json.isNullOrEmpty()) return emptyList()
        return try {
            val array = JSONArray(json)
            (0 until array.length()).map {
                val o = array.getJSONObject(it)
                Row.Button(o.getString("id"), o.getString("title"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    companion object {
        const val STATE_SENT = 0
        const val STATE_SENDING = 1
        const val STATE_FAILED = 2
        private const val KEEP = 500

        @Volatile private var instance: ChatStore? = null

        fun get(context: Context): ChatStore =
            instance ?: synchronized(this) { instance ?: ChatStore(context).also { instance = it } }
    }
}
