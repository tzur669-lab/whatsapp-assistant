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
}
