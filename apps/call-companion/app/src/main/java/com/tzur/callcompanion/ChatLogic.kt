package com.tzur.callcompanion

/**
 * The chat's rules that need no Android: the commands `/` offers, what a
 * conversation is called, and which conversation a server row belongs to.
 * Pure Kotlin, so they are tested on the JVM.
 */
object ChatLogic {
    /**
     * Where everything the assistant sends on its own goes: reminders, the daily
     * digest, birthdays. Not a uuid, so it is never sent to the server as a
     * conversation — a button pressed here goes without one.
     */
    const val REMINDERS = "reminders"

    private const val MAX_TITLE = 40

    /** A command the server understands (`bot/src/core/router.ts`). */
    class Command(
        /** What the list shows, arguments included. */
        val usage: String,
        /** What a tap puts in the field. A trailing space means: an argument follows. */
        val insert: String,
        val description: String,
    )

    /** The app's commands, in the order the guide lists them. Kept in step with the server's router. */
    val COMMANDS: List<Command> = listOf(
        Command("/help", "/help", "מה אפשר לבקש, עם דוגמאות"),
        Command("/status", "/status", "מצב המערכת: יומן מחובר, תזכורות ממתינות, תקלה אחרונה"),
        Command("/forget", "/forget", "מחיקת הזיכרון של הבוט מכל השיחות"),
        Command("/digest", "/digest", "מה מוגדר לתקציר היומי"),
        Command("/digest <שעה>", "/digest ", "תקציר יומי בשעה הזאת, למשל 7. ביום ריק לא נשלח"),
        Command("/digest off", "/digest off", "כיבוי התקציר היומי"),
        Command("/birthday", "/birthday", "רשימת ימי ההולדת השמורים"),
        Command("/birthday <שם> <יום.חודש>", "/birthday ", "הוספת יום הולדת, למשל: דנה 14.3"),
        Command("/birthday מחק <שם>", "/birthday מחק ", "מחיקת יום הולדת"),
        Command("/shabbat", "/shabbat", "האם תזכורות בשבת ובחג נדחות"),
        Command("/shabbat on", "/shabbat on", "תזכורות בשבת ובחג יישלחו במוצאי שבת"),
        Command("/shabbat off", "/shabbat off", "תזכורות נשלחות בזמן, גם בשבת"),
        Command("/ical <קישור>", "/ical ", "חיבור יומן חיצוני לקריאה, לפי קישור ics"),
        Command("/ical off", "/ical off", "ניתוק היומן החיצוני"),
        Command("/connect google", "/connect google", "חיבור יומן Google (קישור חד-פעמי)"),
        Command("/connect gmail", "/connect gmail", "חיבור Gmail: קריאת מיילים וכתיבת טיוטות (לא נשלחות)"),
        Command("/connect tasks", "/connect tasks", "חיבור Google Tasks: רשימות קניות ומשימות"),
        Command("/connect drive", "/connect drive", "חיבור Google Drive: חיפוש קבצים לפי שם"),
        Command("/city", "/city", "העיר לתחזית ולזמני שבת"),
        Command("/city <עיר>", "/city ", "שינוי העיר, למשל: חיפה"),
        Command("/pause", "/pause", "השהיית הבוט: תזכורות ממשיכות, פעולות חדשות לא"),
        Command("/resume", "/resume", "הפעלה מחדש אחרי השהיה"),
        Command("/ping", "/ping", "בדיקה שהשרת עונה"),
        Command("/pair off", "/pair off", "ניתוק הטלפון הזה מהבוט"),
    )

    /**
     * What `/` offers for what is typed so far: nothing unless the field starts
     * with `/` and is still one line; everything for a bare `/`; otherwise the
     * commands whose usage starts with it, case aside.
     */
    fun commandsFor(typed: String): List<Command> {
        if (!typed.startsWith("/") || typed.contains('\n')) return emptyList()
        val wanted = typed.trimEnd().lowercase()
        return COMMANDS.filter { it.usage.lowercase().startsWith(wanted) || it.insert.lowercase().startsWith(wanted) }
    }

    /** A conversation is named after its first message, like an LLM client's. */
    fun titleFor(kind: String, text: String): String {
        if (kind == "voice") return "הודעה קולית"
        val line = text.trim().lineSequence().firstOrNull()?.trim().orEmpty()
        if (line.isEmpty()) return "שיחה"
        return if (line.length <= MAX_TITLE) line else line.take(MAX_TITLE - 1).trimEnd() + "…"
    }

    /**
     * A row from the server goes where the message it answers was written; a
     * row that answers nothing, or answers a message no longer on this phone,
     * goes to [REMINDERS].
     */
    fun conversationForRow(conversationOfAnswered: String?): String = conversationOfAnswered ?: REMINDERS

    /** Only a real conversation id goes to the server; [REMINDERS] never does. */
    fun wireConversation(conversation: String?): String? =
        conversation?.takeIf { Protocol.MESSAGE_ID.matches(it) }

    /**
     * Text shared from another app (2026-10-06): the subject, when there is one
     * and the text does not already start with it, then the text. Capped at the
     * server's limit, on a whole character. Null when nothing is left.
     */
    fun sharedOf(text: String?, subject: String?): String? {
        val body = text?.trim().orEmpty()
        val title = subject?.trim().orEmpty()
        val joined = when {
            title.isEmpty() -> body
            body.isEmpty() || body.startsWith(title) -> body.ifEmpty { title }
            else -> "$title\n$body"
        }
        if (joined.isEmpty()) return null
        if (joined.length <= Protocol.MAX_SHARED_CHARS) return joined
        var end = Protocol.MAX_SHARED_CHARS
        if (Character.isHighSurrogate(joined[end - 1])) end--
        return joined.substring(0, end)
    }

    /** What the chat shows for a message sent with shared text: the request, then the text quoted. */
    fun sharedDisplay(text: String, shared: String): String = "$text\n\n«$shared»"

    /**
     * The mode a message in [conversation] goes with (0.12): the one stored
     * when the conversation was created, else the one chosen for it before its
     * first message, else local. [ChatLogic.REMINDERS] has none.
     */
    fun modeFor(conversation: String, stored: String?, chosen: String?): String? = when {
        wireConversation(conversation) == null -> null
        stored != null -> ChatSchema.modeOf(stored)
        chosen != null -> ChatSchema.modeOf(chosen)
        else -> Protocol.MODE_LOCAL
    }

    /** Smart can be chosen only when the server said so; unknown is no. */
    fun smartSelectable(serverSmart: Boolean?): Boolean = serverSmart == true

    /** Why the server refused a message, as the chat says it. */
    enum class Refusal { MODE_MISMATCH, NOT_AVAILABLE, TOO_LARGE, REFUSED }

    fun refusalOf(status: Int, code: String?): Refusal = when {
        status == 422 && code == "mode_mismatch" -> Refusal.MODE_MISMATCH
        status == 404 -> Refusal.NOT_AVAILABLE
        status == 413 -> Refusal.TOO_LARGE
        else -> Refusal.REFUSED
    }

    /**
     * Whether a refused message is sent again (same id): only after a server
     * failure. A 4xx — a 422 `mode_mismatch` above all — would only be refused again.
     */
    fun retriesAfterRefusal(status: Int): Boolean = status >= 500

    /** A request sent with shared text may not be a command: the server refuses one. */
    fun canSendWithShared(text: String): Boolean = !text.trimStart().startsWith("/")
}
