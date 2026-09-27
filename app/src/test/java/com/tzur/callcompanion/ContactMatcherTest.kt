package com.tzur.callcompanion

import org.junit.Assert.assertEquals
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
            ContactMatcher.match(listOf("דוד דני", "דני"), book),
        )
    }

    @Test fun `one word shared by several contacts is several candidates`() {
        val found = ContactMatcher.match(listOf("דני"), book)
        assertEquals(setOf("דוד דני", "דני כהן", "דני לוי"), found.map { it.name }.toSet())
    }

    @Test fun `emoji and punctuation in a contact name do not matter`() {
        assertEquals(listOf("אמא ❤️"), ContactMatcher.match(listOf("אמא"), book).map { it.name })
    }

    @Test fun `the default number is chosen, else a mobile`() {
        assertEquals("0200000004", ContactMatcher.match(listOf("אמא"), book).single().number)
        assertEquals("0500000003", ContactMatcher.match(listOf("דני לוי"), book).single().number)
    }

    @Test fun `case and nikud do not matter`() {
        assertEquals(listOf("Dani Cohen"), ContactMatcher.match(listOf("dani cohen"), book).map { it.name })
        assertEquals(listOf("דוד דני"), ContactMatcher.match(listOf("דָּוִד דָּנִי"), book).map { it.name })
    }

    @Test fun `no contact by that name is nobody`() {
        assertTrue(ContactMatcher.match(listOf("סבתא"), book).isEmpty())
    }

    @Test fun `a contact without a number is never a candidate`() {
        assertTrue(ContactMatcher.match(listOf("בלי מספר"), book).isEmpty())
    }

    @Test fun `a number is never matched against a number`() {
        // Only names are compared. A number in the words matches nobody, even
        // one that is a contact's own number.
        assertTrue(ContactMatcher.match(listOf("0500000001"), book).isEmpty())
    }

    @Test fun `later variants are tried when earlier ones match nothing`() {
        assertEquals(listOf("אמא ❤️"), ContactMatcher.match(listOf("אמא שלי", "אמא"), book).map { it.name })
    }
}
