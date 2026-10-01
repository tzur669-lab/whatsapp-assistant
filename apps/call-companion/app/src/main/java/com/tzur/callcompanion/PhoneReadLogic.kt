package com.tzur.callcompanion

/**
 * The rules of a phone read (PLAN §6.21), without Android, so they are tested
 * on the JVM.
 *
 * The server asks a closed question — contacts by name, recent notifications,
 * recent SMS — and the phone answers with as little as will do: names only,
 * never a number; one-time codes dropped before they leave; every field cut to
 * the server's own caps. The server checks all of it again.
 */
object PhoneReadLogic {
    const val MAX_ITEMS = 20
    const val MAX_TEXT = 300
    const val MAX_TITLE = 100
    const val MAX_NAME = 60
    const val MAX_APP = 40
    private const val MAX_QUERIES = 5
    private const val MAX_QUERY = 100

    sealed class Query {
        class Contacts(val queries: List<String>) : Query()
        class Notifications(val app: String?, val hours: Int) : Query()
        class Sms(val sender: String?, val hours: Int) : Query()

        companion object {
            /**
             * The query from its fields, as [PhoneReads] took them off the wire.
             * Null for anything off-shape: the phone then answers `unsupported`.
             */
            fun of(kind: String?, queries: List<String>?, app: String?, sender: String?, hours: Int?): Query? =
                when (kind) {
                    "contacts" -> queries
                        ?.takeIf { list -> list.size in 1..MAX_QUERIES && list.all { it.isNotBlank() && it.length <= MAX_QUERY } }
                        ?.let { Contacts(it) }
                    "notifications" -> if (hours in 1..24 && fits(app)) Notifications(app, hours!!) else null
                    "sms" -> if (hours in 1..7 * 24 && fits(sender)) Sms(sender, hours!!) else null
                    else -> null
                }

            private fun fits(value: String?): Boolean = value == null || (value.isNotBlank() && value.length <= MAX_APP)
        }
    }

    // -- one-time codes ---------------------------------------------------------

    private val CODE_WORDS = Regex(
        "(קוד|סיסמ|אימות|הזדהות|code|otp|passcode|password|verif|pin\\b|2fa|one[- ]time)",
        RegexOption.IGNORE_CASE,
    )
    private val CODE_DIGITS = Regex("(?<![\\d])\\d{4,8}(?![\\d])")
    /** "G-123456", "123-456": shapes that are codes whatever the words around them. */
    private val CODE_SHAPES = Regex("\\b[A-Z]-\\d{4,8}\\b|(?<![\\d])\\d{3}[- ]\\d{3}(?![\\d])")

    /**
     * A message that carries a one-time code. Dropped on the phone, so a code
     * never reaches the server or the model — not even scrubbed.
     */
    fun looksLikeOtp(text: String): Boolean =
        CODE_SHAPES.containsMatchIn(text) || (CODE_WORDS.containsMatchIn(text) && CODE_DIGITS.containsMatchIn(text))

    // -- matching ---------------------------------------------------------------

    /** Every word of the query appears in the name, after [ContactMatcher.normalize]. */
    fun nameMatches(name: String, query: String?): Boolean {
        if (query == null) return true
        val words = ContactMatcher.normalize(query).split(' ').filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val normalized = ContactMatcher.normalize(name)
        val nameWords = normalized.split(' ').toSet()
        // A word may also be the start of a name word: "וואטסאפ" for "WhatsApp" will not
        // match anyway, but "whats" for "WhatsApp Business" should.
        return words.all { word -> word in nameWords || nameWords.any { it.startsWith(word) } }
    }

    /**
     * Contact names the words name, the same way a call is matched: a whole name
     * first, else every word of a variant. Names only — a number never leaves.
     */
    fun contactNames(queries: List<String>, names: List<String>): List<String> {
        val usable = names.filter { it.isNotBlank() }.distinct().map { it to ContactMatcher.normalize(it) }
        val wanted = queries.map(ContactMatcher::normalize).filter { it.isNotEmpty() }
        for (variant in wanted) {
            val exact = usable.filter { (_, name) -> name == variant }
            if (exact.isNotEmpty()) return exact.map { it.first }.take(MAX_ITEMS)
        }
        for (variant in wanted) {
            val words = variant.split(' ')
            val partial = usable.filter { (_, name) -> name.split(' ').toSet().containsAll(words) }
            if (partial.isNotEmpty()) return partial.map { it.first }.take(MAX_ITEMS)
        }
        return emptyList()
    }

    /** An SMS sender as it may leave the phone: a contact name, a business name, never a number. */
    fun senderLabel(address: String, contactName: String?, unknown: String): String {
        if (!contactName.isNullOrBlank()) return cut(contactName, MAX_NAME)
        // Letters in the address: an alphanumeric sender id ("Leumi"), not a person's number.
        val hasLetters = address.any { it.isLetter() }
        return if (hasLetters) cut(address, MAX_NAME) else unknown
    }

    fun cut(text: String, max: Int): String {
        val oneLine = text.replace(Regex("\\s+"), " ").trim()
        return if (oneLine.length <= max) oneLine else oneLine.take(max - 1).trimEnd() + "…"
    }

    // -- the answer -------------------------------------------------------------

    class Item(
        val name: String? = null,
        val app: String? = null,
        val sender: String? = null,
        val title: String? = null,
        val text: String? = null,
        val at: Long? = null,
    )

    /**
     * What may leave: at most [MAX_ITEMS], every field cut to the server's caps,
     * and blank fields dropped — the server refuses an empty name, app or sender.
     */
    fun capped(items: List<Item>): List<Item> = items.take(MAX_ITEMS).map {
        Item(
            name = clean(it.name, MAX_NAME),
            app = clean(it.app, MAX_APP),
            sender = clean(it.sender, MAX_NAME),
            title = clean(it.title, MAX_TITLE),
            text = clean(it.text, MAX_TEXT),
            at = it.at?.takeIf { at -> at >= 0 },
        )
    }

    private fun clean(value: String?, max: Int): String? = value?.let { cut(it, max) }?.takeIf { it.isNotEmpty() }
}
