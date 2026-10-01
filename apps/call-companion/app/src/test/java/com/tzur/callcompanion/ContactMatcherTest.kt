package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactMatcherTest {
    private fun contact(id: Long, name: String, vararg numbers: PhoneNumber) = Contact(id, name, numbers.toList())
    private fun mobile(n: String, primary: Boolean = false) = PhoneNumber(n, primary, isMobile = true)
    private fun home(n: String, primary: Boolean = false) = PhoneNumber(n, primary, isMobile = false)

    private val book = listOf(
        contact(1, "דוד דני", mobile("0500000001")),
        contact(2, "דני כהן", mobile("0500000002")),
        contact(3, "דני לוי", home("0200000003"), mobile("0500000003")),
        contact(4, "אמא ❤️", home("0200000004", primary = true), mobile("0500000004")),
        contact(5, "Dani Cohen", mobile("0500000005")),
        contact(6, "בלי מספר"),
    )

    @Test fun `a whole name wins over a partial one`() {
        assertEquals(
            listOf(Candidate("דוד דני", "0500000001")),
            ContactMatcher.match(listOf("דוד דני", "דני"), book).candidates,
        )
    }

    @Test fun `one word shared by several contacts is several candidates`() {
        val found = ContactMatcher.match(listOf("דני"), book).candidates
        assertEquals(setOf("דוד דני", "דני כהן", "דני לוי"), found.map { it.name }.toSet())
    }

    @Test fun `emoji and punctuation in a contact name do not matter`() {
        assertEquals(listOf("אמא ❤️"), ContactMatcher.match(listOf("אמא"), book).candidates.map { it.name })
    }

    @Test fun `the default number is chosen, else a mobile`() {
        assertEquals("0200000004", ContactMatcher.match(listOf("אמא"), book).candidates.single().number)
        assertEquals("0500000003", ContactMatcher.match(listOf("דני לוי"), book).candidates.single().number)
    }

    @Test fun `case and nikud do not matter`() {
        assertEquals(listOf("Dani Cohen"), ContactMatcher.match(listOf("dani cohen"), book).candidates.map { it.name })
        assertEquals(listOf("דוד דני"), ContactMatcher.match(listOf("דָּוִד דָּנִי"), book).candidates.map { it.name })
    }

    @Test fun `no contact by that name is nobody`() {
        assertTrue(ContactMatcher.match(listOf("סבתא"), book).candidates.isEmpty())
    }

    @Test fun `a contact without a number is never a candidate`() {
        assertTrue(ContactMatcher.match(listOf("בלי מספר"), book).candidates.isEmpty())
    }

    @Test fun `a number is never matched against a number`() {
        // Only names are compared. A number in the words matches nobody, even
        // one that is a contact's own number.
        assertTrue(ContactMatcher.match(listOf("0500000001"), book).candidates.isEmpty())
    }

    @Test fun `later variants are tried when earlier ones match nothing, and that is partial`() {
        val found = ContactMatcher.match(listOf("אמא שלי", "אמא"), book)
        assertEquals(listOf("אמא ❤️"), found.candidates.map { it.name })
        // "שלי" was said and matched nobody: the phone asks rather than assumes.
        assertTrue(found.partial)
    }

    // -- the same first name, different surnames ---------------------------------

    private val yairs = listOf(
        contact(10, "יאיר דוד", mobile("0500000010")),
        contact(11, "יאיר אלע", mobile("0500000011")),
    )

    @Test fun `the surname decides between two contacts with the same first name`() {
        val found = ContactMatcher.match(listOf("יאיר אלע", "Yair Ela", "יאיר"), yairs)
        assertEquals(listOf("יאיר אלע"), found.candidates.map { it.name })
        assertFalse(found.partial)
    }

    @Test fun `a first name alone is every contact with it, for the user to choose`() {
        val found = ContactMatcher.match(listOf("יאיר", "Yair"), yairs)
        assertEquals(setOf("יאיר דוד", "יאיר אלע"), found.candidates.map { it.name }.toSet())
        assertFalse(found.partial)
    }

    @Test fun `a dropped surname is never a sure match, even with one candidate left`() {
        val onlyDavid = yairs.filter { it.id == 10L }
        val found = ContactMatcher.match(listOf("יאיר אלע", "Yair Ela", "יאיר"), onlyDavid)
        assertEquals(listOf("יאיר דוד"), found.candidates.map { it.name })
        assertTrue(found.partial)
    }

    @Test fun `the fullest variant is tried first, whatever order they came in`() {
        val book = listOf(
            contact(20, "יאיר", mobile("0500000020")),
            contact(21, "יאיר אלע עבודה", mobile("0500000021")),
        )
        val found = ContactMatcher.match(listOf("יאיר", "יאיר אלע"), book)
        assertEquals(listOf("יאיר אלע עבודה"), found.candidates.map { it.name })
        assertFalse(found.partial)
    }

    @Test fun `nothing matched is not partial, it is nobody`() {
        val found = ContactMatcher.match(listOf("סבתא"), yairs)
        assertTrue(found.candidates.isEmpty())
        assertFalse(found.partial)
    }
}
