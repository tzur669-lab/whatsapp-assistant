package com.tzur.callcompanion

import java.util.Locale

/**
 * The quota screen's rules that need no Android (0.6): the report's shape,
 * how a number, a wait or an age is said, and when a bar turns amber or red.
 * Every time is measured on the server's clock — the report's own `at` — so a
 * phone whose clock is off by a minute still says the right thing.
 */
object QuotaLogic {
    class Bucket(val limit: Long, val remaining: Long, val resetAt: Long, val observedAt: Long)
    class Counted(val limit: Long, val used: Long)

    class Model(
        val model: String,
        val role: String,
        /** From Groq's headers. Null until a response for this model has carried them. */
        val requests: Bucket?,
        val minuteTokens: Bucket?,
        /** Counted on the server, over 24 hours. Null where it does not apply (Whisper). */
        val dayTokens: Counted?,
    )

    /** One model's last minute as the server counts it, against its own limit (0.8.1). */
    class ServerMinute(val model: String, val used: Long, val limit: Long, val freesAt: Long?, val blockedUntil: Long?)

    /**
     * The server's own limits, which no Groq header shows (0.8.1). Any of them
     * sends a message to the fallback parser, which cannot answer a question.
     */
    class Server(
        val minute: List<ServerMinute>,
        val turnTokenCap: Long,
        val lastFailureCode: String?,
        val lastFailureAt: Long?,
        val fallbacksToday: Long,
    )

    class Report(
        val at: Long,
        val models: List<Model>,
        val voice: Counted,
        val workerRequests: Counted,
        val workerResetAt: Long,
        /** Null from a server older than 0.8.1. */
        val server: Server? = null,
    )

    /** What the server's last error code means, in words. The code itself is shown beside it. */
    fun failureLabel(code: String): String = when {
        code == "E_AGENT_BUDGET_EXHAUSTED" -> "מכסת הדקה של השרת למודל הייתה מלאה"
        code == "E_AGENT_RATE_LIMITED" -> "Groq סירב: מכסה (429)"
        code == "E_AGENT_TURN_TOKEN_CAP" -> "התור עבר את תקרת הטוקנים לתור"
        code == "E_AGENT_MAX_CALLS" -> "התור עבר את מספר הקריאות למודל"
        code == "E_AGENT_TIMEOUT" -> "Groq לא ענה בזמן"
        code == "E_AGENT_NETWORK_ERROR" -> "אין חיבור ל־Groq"
        code == "E_AGENT_PROVIDER_ERROR" -> "שגיאה מצד Groq"
        code == "E_AGENT_INVALID_JSON" || code == "E_AGENT_EMPTY_REPLY" -> "המודל החזיר תשובה ריקה או פגומה"
        code.startsWith("E_NLU_") -> "גם המנתח הגיבוי נכשל"
        else -> "תקלה אחרת"
    }

    const val OK = 0
    const val WARN = 1
    const val FULL = 2

    fun roleLabel(role: String): String = when (role) {
        "primary" -> "מודל ראשי"
        "fallback" -> "מודל גיבוי"
        "voice" -> "תמלול הקלטות"
        else -> role
    }

    /** How much is used, 0..1. A limit of zero reads as full rather than dividing by it. */
    fun fraction(used: Long, limit: Long): Float =
        if (limit <= 0) 1f else (used.toFloat() / limit).coerceIn(0f, 1f)

    fun level(used: Long, limit: Long): Int {
        val f = fraction(used, limit)
        return when {
            f >= 0.9f -> FULL
            f >= 0.7f -> WARN
            else -> OK
        }
    }

    /** 200000 → "200,000": digits are read left to right, inside an isolate on screen. */
    fun number(n: Long): String = String.format(Locale.US, "%,d", n)

    fun usedOf(limit: Long, used: Long): String = "${number(used)} מתוך ${number(limit)}"

    /** A wait or an age, the way it is said: "פחות מדקה", "דקה", "12 דקות", "שעתיים", "5 שעות". */
    fun duration(ms: Long): String {
        val minutes = ms / 60_000
        if (minutes < 1) return "פחות מדקה"
        if (minutes < 60) return if (minutes == 1L) "דקה" else "$minutes דקות"
        val hours = minutes / 60
        return when (hours) {
            1L -> "שעה"
            2L -> "שעתיים"
            else -> "$hours שעות"
        }
    }

    /** When a bucket refills, measured from the report. Past it, it already has. */
    fun resetsIn(resetAt: Long, at: Long): String =
        if (resetAt <= at) "התמלא מחדש" else "מתאפס בעוד ${duration(resetAt - at)}"

    /** How old Groq's figure is: it is as of the last call to that model. */
    fun age(observedAt: Long, at: Long): String {
        val ms = at - observedAt
        return if (ms < 60_000) "עודכן עכשיו" else "עודכן לפני ${duration(ms)}"
    }
}
