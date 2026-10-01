package com.tzur.callcompanion

import org.json.JSONObject

/**
 * One message from the assistant: a row of the server's outbox (PLAN §6.18),
 * whether it came back in the response to a message or was fetched after a
 * push. `seq` is its identity everywhere — the chat's primary key, the
 * notification's tag, the number in the ack. Seq 0 is an answer the server
 * did not keep (the reply to `/pair off`), shown once and never acked.
 */
class Row(
    val seq: Long,
    val kind: String,
    val inReplyTo: String?,
    val text: String,
    val buttons: List<Button>,
    val createdAt: Long,
    /** A phone action to claim and run (PLAN §6.20). Never its parameters. */
    val card: Card? = null,
) {
    class Button(val id: String, val title: String)

    /**
     * Enough to show the card and to claim it — the parameters come only from
     * the claim, which the server lets succeed once.
     */
    class Card(
        val actionId: String,
        val nonce: String,
        val type: String,
        val preview: String,
        /** The server allows this one to run without the tap, while the chat is open. */
        val autoRun: Boolean,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("actionId", actionId)
            .put("nonce", nonce)
            .put("type", type)
            .put("preview", preview)
            .put("autoRun", autoRun)

        companion object {
            /** The closed list of what a card may be. Anything else is not a card. */
            val TYPES = setOf("alarm", "timer", "nav", "app", "settings", "message")
            private val ACTION_ID = Regex("^[0-9a-f]{24}$")
            private val NONCE = Regex("^[0-9a-f]{32}$")
            private const val MAX_PREVIEW = 2_000

            fun from(json: JSONObject?): Card? {
                if (json == null) return null
                return try {
                    val card = Card(
                        actionId = json.getString("actionId"),
                        nonce = json.getString("nonce"),
                        type = json.getString("type"),
                        preview = json.getString("preview"),
                        autoRun = json.getBoolean("autoRun"),
                    )
                    val ok = ACTION_ID.matches(card.actionId) && NONCE.matches(card.nonce) &&
                        card.type in TYPES && card.preview.length <= MAX_PREVIEW
                    if (ok) card else null
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    /** A reminder rings; everything else is a message. */
    val isReminder: Boolean get() = kind == "reminder"

    companion object {
        private val KINDS = setOf("reply", "reminder", "digest", "call", "notice")
        private const val MAX_TEXT = 20_000
        private const val MAX_BUTTONS = 10
        private const val MAX_TITLE = 64

        /** Null for anything off-shape. The server is trusted, but not to be well-formed forever. */
        fun from(json: JSONObject?): Row? {
            if (json == null) return null
            return try {
                val seq = json.getLong("seq")
                val kind = json.getString("kind")
                val text = json.getString("text")
                if (seq < 0 || kind !in KINDS || text.length > MAX_TEXT) return null

                val inReplyTo = if (json.isNull("inReplyTo")) null else json.optString("inReplyTo")
                    .takeIf { Protocol.MESSAGE_ID.matches(it) }

                val array = json.optJSONArray("buttons")
                val buttons = mutableListOf<Button>()
                if (array != null) {
                    for (i in 0 until minOf(array.length(), MAX_BUTTONS)) {
                        val button = array.optJSONObject(i) ?: continue
                        val id = button.optString("id")
                        val title = button.optString("title")
                        if (Protocol.BUTTON_ID.matches(id) && title.isNotBlank() && title.length <= MAX_TITLE) {
                            buttons += Button(id, title)
                        }
                    }
                }
                Row(
                    seq,
                    kind,
                    inReplyTo,
                    text,
                    buttons,
                    json.optLong("createdAt", System.currentTimeMillis()),
                    Card.from(json.optJSONObject("card")),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}
