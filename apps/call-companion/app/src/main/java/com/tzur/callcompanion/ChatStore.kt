package com.tzur.callcompanion

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The chat history. It lives only on this phone, in the app's private
 * database, excluded from backup and device transfer
 * (`data_extraction_rules.xml`). The server keeps nothing it has delivered.
 *
 * A server row is stored under its `seq`, which is UNIQUE: the first write
 * wins and a second fetch of the same row is ignored, so a push, a poll and
 * the response to a message can all deliver it without a duplicate. The order
 * on screen is arrival order; each row keeps the time the server wrote it.
 *
 * Messages belong to conversations, like an LLM client's (0.5). An answer
 * goes to the conversation of the message it answers; what the assistant
 * sends on its own goes to [ChatLogic.REMINDERS].
 */
class ChatStore private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "chat.db", null, 3) {

    class Conversation(val id: String, val title: String, val updatedAt: Long)

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
        /** A phone action under this message (PLAN §6.20), and how far it got. */
        val card: Row.Card?,
        val cardState: Int,
        val conversation: String,
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
              arrived_at INTEGER NOT NULL,
              card       TEXT,
              card_state INTEGER NOT NULL DEFAULT 0,
              conversation TEXT NOT NULL DEFAULT '${ChatLogic.REMINDERS}'
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX messages_message_id ON messages (message_id)")
        createConversations(db)
    }

    private fun createConversations(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE conversations (
              id         TEXT PRIMARY KEY,
              title      TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX messages_conversation ON messages (conversation, local_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // 0.3: action cards (PLAN §6.20). Earlier rows simply have none.
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE messages ADD COLUMN card TEXT")
            db.execSQL("ALTER TABLE messages ADD COLUMN card_state INTEGER NOT NULL DEFAULT 0")
        }
        // 0.5: conversations. The one thread of before becomes a conversation of
        // its own; what answered nothing (reminders, digests) moves to theirs.
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE messages ADD COLUMN conversation TEXT NOT NULL DEFAULT '${ChatLogic.REMINDERS}'")
            createConversations(db)
            val earlier = UUID.randomUUID().toString()
            val now = System.currentTimeMillis()
            db.execSQL(
                "UPDATE messages SET conversation = ? WHERE outgoing = 1 OR message_id IS NOT NULL OR kind = 'notice'",
                arrayOf(earlier),
            )
            val any = db.rawQuery("SELECT 1 FROM messages WHERE conversation = ? LIMIT 1", arrayOf(earlier)).use { it.moveToFirst() }
            if (any) {
                db.insert("conversations", null, ContentValues().apply {
                    put("id", earlier)
                    put("title", "שיחה קודמת")
                    put("created_at", now)
                    put("updated_at", now)
                })
            }
        }
    }

    // -- conversations --------------------------------------------------------

    /** Every conversation, the most recently used first. [ChatLogic.REMINDERS] is not one of them. */
    fun conversations(): List<Conversation> =
        readableDatabase.rawQuery("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC", null).use { c ->
            val out = ArrayList<Conversation>(c.count)
            while (c.moveToNext()) out += Conversation(c.getString(0), c.getString(1), c.getLong(2))
            out
        }

    fun titleOf(conversation: String): String? =
        readableDatabase.rawQuery("SELECT title FROM conversations WHERE id = ?", arrayOf(conversation))
            .use { if (it.moveToFirst()) it.getString(0) else null }

    /** The conversation a sent message was written in, or null if it is no longer here. */
    fun conversationOfMessage(messageId: String): String? =
        readableDatabase.rawQuery(
            "SELECT conversation FROM messages WHERE outgoing = 1 AND message_id = ? LIMIT 1",
            arrayOf(messageId),
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    /** The conversation a row from the server was put in. */
    fun conversationOfSeq(seq: Long): String? =
        readableDatabase.rawQuery("SELECT conversation FROM messages WHERE seq = ? LIMIT 1", arrayOf(seq.toString()))
            .use { if (it.moveToFirst()) it.getString(0) else null }

    /** Deletes the conversation and its messages from this phone. The server's memory of it expires on its own. */
    fun deleteConversation(conversation: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("messages", "conversation = ?", arrayOf(conversation))
            db.delete("conversations", "id = ?", arrayOf(conversation))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun touch(db: SQLiteDatabase, conversation: String, now: Long) {
        if (conversation == ChatLogic.REMINDERS) return
        db.update("conversations", ContentValues().apply { put("updated_at", now) }, "id = ?", arrayOf(conversation))
    }

    /**
     * What the user typed, said or tapped, before it is sent. The first message
     * of a conversation creates it, and names it.
     */
    fun addOutgoing(messageId: String, kind: String, text: String, conversation: String) {
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (conversation != ChatLogic.REMINDERS) {
                db.insertWithOnConflict("conversations", null, ContentValues().apply {
                    put("id", conversation)
                    put("title", ChatLogic.titleFor(kind, text))
                    put("created_at", now)
                    put("updated_at", now)
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.insert("messages", null, ContentValues().apply {
                put("outgoing", 1)
                put("message_id", messageId)
                put("kind", kind)
                put("text", text)
                put("state", STATE_SENDING)
                put("created_at", now)
                put("arrived_at", now)
                put("conversation", conversation)
            })
            touch(db, conversation, now)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
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
    fun saveRows(rows: List<Row>, into: String? = null): List<Row> {
        val fresh = mutableListOf<Row>()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val now = System.currentTimeMillis()
            for (row in rows) {
                val conversation = into
                    ?: ChatLogic.conversationForRow(row.inReplyTo?.let { conversationOfMessage(it) })
                val values = ContentValues().apply {
                    if (row.seq > 0) put("seq", row.seq) else putNull("seq")
                    put("outgoing", 0)
                    put("message_id", row.inReplyTo)
                    put("kind", row.kind)
                    put("text", row.text)
                    put("buttons", buttonsJson(row.buttons))
                    if (row.card != null) put("card", row.card.toJson().toString()) else putNull("card")
                    put("created_at", row.createdAt)
                    put("arrived_at", now)
                    put("conversation", conversation)
                }
                val id = db.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_IGNORE)
                if (id != -1L) {
                    fresh += row
                    touch(db, conversation, now)
                }
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
     * A line from the app itself — "no connection" and the like — in the
     * conversation it is about. Never sent anywhere, and answers nothing: it
     * must not mark a message as arrived.
     */
    fun addNotice(text: String, conversation: String) {
        saveRows(listOf(Row(0, "notice", null, text, emptyList(), System.currentTimeMillis())), into = conversation)
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

    /**
     * Take a card for running: true for exactly one caller. The tap, the
     * auto-run and a second screen all go through here, so a card is claimed
     * from this phone once even before the server's own once-only claim.
     */
    fun takeCard(seq: Long): Boolean =
        writableDatabase.compileStatement(
            "UPDATE messages SET card_state = $CARD_WORKING WHERE seq = ? AND card_state = $CARD_OPEN AND card IS NOT NULL",
        ).apply { bindLong(1, seq) }.executeUpdateDelete() == 1

    fun setCardState(seq: Long, state: Int) {
        writableDatabase.update("messages", ContentValues().apply { put("card_state", state) }, "seq = ?", arrayOf(seq.toString()))
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

    fun all(conversation: String): List<Message> =
        readableDatabase.rawQuery(
            "SELECT * FROM messages WHERE conversation = ? ORDER BY local_id",
            arrayOf(conversation),
        ).use { cursor ->
            val out = ArrayList<Message>(cursor.count)
            while (cursor.moveToNext()) out += message(cursor)
            out
        }

    /** The oldest messages go first; a conversation left with none goes with them. */
    private fun trim() {
        val db = writableDatabase
        db.execSQL(
            "DELETE FROM messages WHERE local_id NOT IN (SELECT local_id FROM messages ORDER BY local_id DESC LIMIT $KEEP)",
        )
        db.execSQL("DELETE FROM conversations WHERE id NOT IN (SELECT DISTINCT conversation FROM messages)")
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
        card = c.getString(c.getColumnIndexOrThrow("card"))?.let { json ->
            try {
                Row.Card.from(JSONObject(json))
            } catch (_: Exception) {
                null
            }
        },
        cardState = c.getInt(c.getColumnIndexOrThrow("card_state")),
        conversation = c.getString(c.getColumnIndexOrThrow("conversation")),
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

        /** A card's life on this phone (PLAN §6.20). */
        const val CARD_OPEN = 0
        const val CARD_WORKING = 1
        const val CARD_DONE = 2
        const val CARD_REFUSED = 3
        const val CARD_FAILED = 4
        const val CARD_EXPIRED = 5

        /** Across every conversation. */
        private const val KEEP = 3_000

        @Volatile private var instance: ChatStore? = null

        fun get(context: Context): ChatStore =
            instance ?: synchronized(this) { instance ?: ChatStore(context).also { instance = it } }
    }
}
