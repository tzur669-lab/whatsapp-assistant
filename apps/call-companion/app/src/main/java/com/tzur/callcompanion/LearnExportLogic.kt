package com.tzur.callcompanion

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The learning export's rules that need no Android (0.18, PLAN §6.31, block K3):
 * the file name and the check that the server's answer is the export.
 */
object LearnExportLogic {
    const val PATH = "/app/learn/export"
    const val MIME = "application/json"

    /** `bot-learn-YYYY-MM-DD.json`, the date in the phone's own zone unless one is given. */
    fun fileName(now: Date, zone: TimeZone = TimeZone.getDefault()): String {
        val format = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        format.timeZone = zone
        return "bot-learn-${format.format(now)}.json"
    }

    private val OBJECT_WITH_SCHEMA = Regex("""^\s*\{[\s\S]*"schema"\s*:""")

    /**
     * True when the text looks like a JSON object carrying a `schema`. A shape
     * check on the text (the parsed answer was already checked in [Api]), kept
     * free of org.json so the JVM tests can run it.
     */
    fun isExport(text: String?): Boolean = text != null && OBJECT_WITH_SCHEMA.containsMatchIn(text)
}
