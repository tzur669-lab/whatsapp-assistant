package com.tzur.callcompanion

/**
 * What the home-screen widget shows (0.11, ROADMAP #22): the newest reminder
 * the phone has stored, from the rows it already fetched — nothing is asked of
 * the server for it. A private row (text someone else wrote, such as a "time
 * to leave" reminder with a calendar title) shows only that a reminder came.
 */
object WidgetLogic {
    const val MAX_CHARS = 120

    class Line(val text: String?, val at: Long)

    /** The newest reminder among [rows], or null when there is none. */
    fun latest(rows: List<Row>): Line? {
        val newest = rows.filter { it.kind == "reminder" }.maxByOrNull { it.seq } ?: return null
        return Line(if (newest.private) null else clip(newest.text), newest.createdAt)
    }

    /** Whether [candidate] should replace what the widget shows now. */
    fun replaces(candidate: Line, shownAt: Long): Boolean = candidate.at >= shownAt

    /** One line's worth, cut on a whole character. */
    fun clip(text: String): String {
        val flat = text.replace('\n', ' ').trim()
        if (flat.length <= MAX_CHARS) return flat
        var end = MAX_CHARS - 1
        if (Character.isHighSurrogate(flat[end - 1])) end--
        return flat.substring(0, end).trimEnd() + "…"
    }
}
