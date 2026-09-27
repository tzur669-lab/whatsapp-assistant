package com.tzur.callcompanion

/**
 * Match the words the assistant sent against this phone's own contacts.
 *
 * This is PLAN §6.17's "code finds targets", moved onto the phone: the model
 * supplied words, this code decides who they mean, and the contact list is the
 * allowlist of destinations. Only display names are compared — never numbers —
 * so no text can name a destination that is not already a contact.
 *
 * Pure Kotlin, so the rules are tested on the JVM without a device.
 */
data class PhoneNumber(val number: String, val isPrimary: Boolean, val isMobile: Boolean)

data class Contact(val id: Long, val name: String, val numbers: List<PhoneNumber>)

data class Candidate(val name: String, val number: String)

object ContactMatcher {
    private val NIKUD = Regex("[\\u0591-\\u05C7]")
    private val NOT_A_WORD = Regex("[^\\p{L}\\p{N}]+")

    /** Nikud, punctuation, emoji and case do not make two names different. */
    fun normalize(text: String): String =
        NIKUD.replace(text, "").lowercase().replace(NOT_A_WORD, " ").trim()

    /**
     * The contacts the words name, best reading first:
     *
     *   1. a contact whose whole name is one of the variants ("דוד דני");
     *   2. otherwise, contacts whose name contains every word of a variant
     *      ("דני" → "דני כהן" and "דני לוי" — two, so the phone asks which).
     *
     * Variants are tried in the order sent, and the first that matches anything
     * decides. An empty list means no contact by that name: nothing is dialled.
     */
    fun match(variants: List<String>, contacts: List<Contact>): List<Candidate> {
        val usable = contacts
            .filter { it.numbers.isNotEmpty() && it.name.isNotBlank() }
            .map { it to normalize(it.name) }
        val wanted = variants.map(::normalize).filter { it.isNotEmpty() }

        for (variant in wanted) {
            val exact = usable.filter { (_, name) -> name == variant }
            if (exact.isNotEmpty()) return candidatesOf(exact.map { it.first })
        }

        for (variant in wanted) {
            val words = variant.split(' ')
            val partial = usable.filter { (_, name) ->
                val nameWords = name.split(' ').toSet()
                words.all { it in nameWords }
            }
            if (partial.isNotEmpty()) return candidatesOf(partial.map { it.first })
        }

        return emptyList()
    }

    private fun candidatesOf(contacts: List<Contact>): List<Candidate> =
        contacts.distinctBy { it.id }.map { Candidate(it.name, bestNumber(it.numbers)) }

    /** The number the user marked default, else a mobile, else the first. */
    private fun bestNumber(numbers: List<PhoneNumber>): String =
        (numbers.firstOrNull { it.isPrimary } ?: numbers.firstOrNull { it.isMobile } ?: numbers.first()).number
}
