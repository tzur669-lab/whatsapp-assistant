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

    /** A file a card may save (2026-10-05, the expenses export). */
    data class FileCard(val name: String, val content: String)

    private val FILE_NAME = Regex("^[a-z0-9-]{1,48}\\.csv$")
    const val MAX_FILE_CHARS = 150_000

    /**
     * The checks the server already made, made again here: a plain lowercase
     * name ending in .csv (no path, nothing to escape a folder with), CSV only,
     * and a bounded size. Null for anything else.
     */
    fun fileCard(type: String, name: String?, mime: String?, content: String?): FileCard? {
        if (type != "file" || mime != "text/csv") return null
        if (name == null || !FILE_NAME.matches(name)) return null
        if (content == null || content.isEmpty() || content.length > MAX_FILE_CHARS) return null
        return FileCard(name, content)
    }
}
