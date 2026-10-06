package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneReadLogicTest {
    @Test
    fun parsesTheThreeQueriesAndNothingElse() {
        // A lambda, not a reference: `of` has defaulted parameters since the call log (2026-10-06).
        val of = { kind: String?, queries: List<String>?, app: String?, sender: String?, hours: Int? ->
            PhoneReadLogic.Query.of(kind, queries, app, sender, hours)
        }
        assertTrue(of("contacts", listOf("דני"), null, null, null) is PhoneReadLogic.Query.Contacts)
        assertEquals("אמא", (of("sms", null, null, "אמא", 24) as PhoneReadLogic.Query.Sms).sender)
        assertNull((of("notifications", null, null, null, 2) as PhoneReadLogic.Query.Notifications).app)

        assertNull(of("calls", null, null, null, 2))
        assertNull(of("notifications", null, null, null, 48))
        assertNull(of("notifications", null, null, null, null))
        assertNull(of("contacts", emptyList(), null, null, null))
        assertNull(of("sms", null, null, "", 1))
    }

    @Test
    fun dropsOneTimeCodesButKeepsOrdinaryNumbers() {
        assertTrue(PhoneReadLogic.looksLikeOtp("קוד האימות שלך הוא 482913"))
        assertTrue(PhoneReadLogic.looksLikeOtp("Your verification code: 1234"))
        assertTrue(PhoneReadLogic.looksLikeOtp("G-482913 is your Google verification code"))
        assertTrue(PhoneReadLogic.looksLikeOtp("הסיסמה החד פעמית: 1234"))
        assertFalse(PhoneReadLogic.looksLikeOtp("נפגשים ב-8 בבית קפה, שולחן 12"))
        assertFalse(PhoneReadLogic.looksLikeOtp("החבילה שלך תגיע מחר"))
    }

    @Test
    fun matchesContactNamesTheWayACallIsMatched() {
        val names = listOf("דני כהן", "דני לוי", "אמא", "Dana Levi")
        assertEquals(listOf("אמא"), PhoneReadLogic.contactNames(listOf("אמא"), names))
        assertEquals(listOf("דני כהן", "דני לוי"), PhoneReadLogic.contactNames(listOf("דני"), names))
        assertEquals(listOf("Dana Levi"), PhoneReadLogic.contactNames(listOf("dana"), names))
        assertEquals(emptyList<String>(), PhoneReadLogic.contactNames(listOf("יוסי"), names))
    }

    @Test
    fun neverLetsANumberLeaveAsASender() {
        assertEquals("אמא", PhoneReadLogic.senderLabel("+972500000000", "אמא", "מספר לא שמור"))
        assertEquals("מספר לא שמור", PhoneReadLogic.senderLabel("+972500000000", null, "מספר לא שמור"))
        assertEquals("Leumi", PhoneReadLogic.senderLabel("Leumi", null, "מספר לא שמור"))
    }

    @Test
    fun filtersByWordsOrTheirStart() {
        assertTrue(PhoneReadLogic.nameMatches("WhatsApp Business", "whats"))
        assertTrue(PhoneReadLogic.nameMatches("אמא", null))
        assertFalse(PhoneReadLogic.nameMatches("Gmail", "whatsapp"))
    }

    @Test
    fun capsEveryFieldAndLeavesBlanksOut() {
        val items = PhoneReadLogic.capped(List(30) { PhoneReadLogic.Item(sender = "  ", text = "x".repeat(500), at = 1L) })
        assertEquals(PhoneReadLogic.MAX_ITEMS, items.size)
        assertNull(items[0].sender)
        assertEquals(PhoneReadLogic.MAX_TEXT, items[0].text!!.length)
        assertEquals(1L, items[0].at)
    }

    @Test
    fun parsesTheCallLogQuery() {
        val calls = PhoneReadLogic.Query.of("calls", null, null, null, 24, name = "דנה", missed = true) as PhoneReadLogic.Query.Calls
        assertEquals("דנה", calls.name)
        assertTrue(calls.missed)
        assertTrue(PhoneReadLogic.Query.of("calls", null, null, null, 168, missed = false) is PhoneReadLogic.Query.Calls)
        assertNull(PhoneReadLogic.Query.of("calls", null, null, null, 169, missed = false))
        assertNull(PhoneReadLogic.Query.of("calls", null, null, null, 24))
        assertNull(PhoneReadLogic.Query.of("calls", null, null, null, 24, name = "", missed = false))
    }

    @Test
    fun namesACallDirectionFromTheClosedListOnly() {
        assertEquals("missed", PhoneReadLogic.callDirection(PhoneReadLogic.CALL_MISSED))
        assertEquals("incoming", PhoneReadLogic.callDirection(PhoneReadLogic.CALL_INCOMING))
        assertEquals("outgoing", PhoneReadLogic.callDirection(PhoneReadLogic.CALL_OUTGOING))
        assertEquals("rejected", PhoneReadLogic.callDirection(PhoneReadLogic.CALL_REJECTED))
        // Voicemail and blocked are left out.
        assertNull(PhoneReadLogic.callDirection(4))
        assertNull(PhoneReadLogic.callDirection(6))
    }

    @Test
    fun aCallerIsANameAndNeverANumber() {
        assertEquals("דנה כהן", PhoneReadLogic.callerName("דנה כהן", "Dana"))
        assertEquals("Dana", PhoneReadLogic.callerName(null, "Dana"))
        assertNull(PhoneReadLogic.callerName(null, "+972 50-000-0000"))
        assertNull(PhoneReadLogic.callerName("", null))
    }
}
