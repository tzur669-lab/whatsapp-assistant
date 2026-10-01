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
}
