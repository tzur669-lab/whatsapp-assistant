package com.tzur.callcompanion

/**
 * The parts of running a card that are rules rather than Android (PLAN §6.20):
 * which installed app the words mean, and a contact's number in the form
 * WhatsApp's link takes. Pure Kotlin, tested on the JVM.
 */
object CardLogic {
    data class App(val label: String, val packageName: String)

    /**
     * The installed apps the words name, best reading first: a label equal to a
     * variant; else a label that contains a variant, or is contained in one
     * ("Waze" in "waze navigation"). Short words never match by containment —
     * "a" is inside half the apps on a phone.
     */
    fun matchApps(variants: List<String>, apps: List<App>): List<App> {
        val wanted = variants.map(ContactMatcher::normalize).filter { it.isNotEmpty() }
        val named = apps.map { it to ContactMatcher.normalize(it.label) }.filter { it.second.isNotEmpty() }

        for (variant in wanted) {
            val exact = named.filter { (_, label) -> label == variant }
            if (exact.isNotEmpty()) return exact.map { it.first }.distinctBy { it.packageName }
        }
        for (variant in wanted) {
            if (variant.length < 3) continue
            val partial = named.filter { (_, label) ->
                label.length >= 3 && (label.contains(variant) || variant.contains(label))
            }
            if (partial.isNotEmpty()) return partial.map { it.first }.distinctBy { it.packageName }
        }
        return emptyList()
    }

    /**
     * A phone number as `wa.me` wants it: country code and digits, nothing
     * else. An Israeli local number (05X…) gets 972 in place of its leading 0.
     * Null for anything that does not look like a phone number.
     */
    fun whatsAppNumber(raw: String): String? {
        val trimmed = raw.trim()
        val digits = trimmed.filter { it.isDigit() }
        val international = when {
            trimmed.startsWith("+") -> digits
            digits.startsWith("00") -> digits.drop(2)
            digits.startsWith("0") -> "972" + digits.drop(1)
            else -> digits
        }
        return international.takeIf { it.length in 8..15 }
    }

    /** A file a card may save (2026-10-05, the expenses export; Markdown documents since 0.20.0, block L, L6). */
    data class FileCard(val name: String, val mime: String, val content: String)

    /** The only pairs: a CSV export, or a Markdown document. Each name must end in its own type. */
    private val FILE_NAMES = mapOf(
        "text/csv" to Regex("^[a-z0-9-]{1,48}\\.csv$"),
        "text/markdown" to Regex("^[a-z0-9-]{1,48}\\.md$"),
    )
    const val MAX_FILE_CHARS = 150_000

    /**
     * The checks the server already made, made again here: a plain lowercase
     * name ending in the type's own extension (no path, nothing to escape a
     * folder with), CSV or Markdown only, and a bounded size. Null for anything else.
     */
    fun fileCard(type: String, name: String?, mime: String?, content: String?): FileCard? {
        if (type != "file" || mime == null) return null
        val pattern = FILE_NAMES[mime] ?: return null
        if (name == null || !pattern.matches(name)) return null
        if (content == null || content.isEmpty() || content.length > MAX_FILE_CHARS) return null
        return FileCard(name, mime, content)
    }
}
