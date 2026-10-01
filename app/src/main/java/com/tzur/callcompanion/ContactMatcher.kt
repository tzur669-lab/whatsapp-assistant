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

/**
 * Who the words could mean. `partial` is true when the contacts found match
 * fewer words than were said ("יאיר אלע" → only "יאיר" matched anybody): the
 * phone then asks "did you mean…?" and never treats the match as sure, even
 * with a single candidate left (§6.17).
 */
data class Match(val candidates: List<Candidate>, val partial: Boolean)

object ContactMatcher {
    private val NIKUD = Regex("[\\u0591-\\u05C7]")
    private val NOT_A_WORD = Regex("[^\\p{L}\\p{N}]+")

    /** Nikud, punctuation, emoji and case do not make two names different. */
    fun normalize(text: String): String =
        NIKUD.replace(text, "").lowercase().replace(NOT_A_WORD, " ").trim()

    /**
     * The contacts the words name. The fullest variant is tried first — the one
     * with the most words, so a surname is never dropped while a reading that
     * keeps it still matches — and for each variant:
     *
     *   1. a contact whose whole name is the variant ("דוד דני");
     *   2. otherwise, contacts whose name contains every word of it
     *      ("דני" → "דני כהן" and "דני לוי" — two, so the phone asks which).
     *
     * The first variant that matches anything decides. If it has fewer words
     * than the fullest one, the match is `partial`. No candidates means no
     * contact by that name: nothing is dialled.
     */
    fun match(variants: List<String>, contacts: List<Contact>): Match {
        val usable = contacts
            .filter { it.numbers.isNotEmpty() && it.name.isNotBlank() }
            .map { it to normalize(it.name) }
        // Stable: variants of equal length keep the order they were sent in.
        val wanted = variants.map(::normalize).filter { it.isNotEmpty() }.sortedByDescending { words(it).size }
        val fullest = wanted.firstOrNull()?.let { words(it).size } ?: 0

        for (variant in wanted) {
            val exact = usable.filter { (_, name) -> name == variant }
            val found = exact.ifEmpty {
                val needed = words(variant)
                usable.filter { (_, name) -> words(name).toSet().containsAll(needed) }
            }
            if (found.isNotEmpty()) {
                return Match(candidatesOf(found.map { it.first }), partial = words(variant).size < fullest)
            }
        }

        return Match(emptyList(), partial = false)
    }

    private fun words(text: String): List<String> = text.split(' ').filter { it.isNotEmpty() }

    private fun candidatesOf(contacts: List<Contact>): List<Candidate> =
        contacts.distinctBy { it.id }.map { Candidate(it.name, bestNumber(it.numbers)) }

    /** The number the user marked default, else a mobile, else the first. */
    private fun bestNumber(numbers: List<PhoneNumber>): String =
        (numbers.firstOrNull { it.isPrimary } ?: numbers.firstOrNull { it.isMobile } ?: numbers.first()).number
}
