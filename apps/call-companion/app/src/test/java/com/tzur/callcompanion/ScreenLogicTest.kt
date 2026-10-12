package com.tzur.callcompanion

import com.tzur.callcompanion.RoutineLogic.Node
import com.tzur.callcompanion.RoutineLogic.Pick
import com.tzur.callcompanion.ScreenLogic.Cls
import com.tzur.callcompanion.ScreenLogic.Event
import com.tzur.callcompanion.ScreenLogic.Status
import com.tzur.callcompanion.ScreenLogic.Why
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenLogicTest {
    private val pkg = "il.co.fid"

    private fun node(
        text: String? = null,
        desc: String? = null,
        id: String? = null,
        target: Int = -1,
        visible: Boolean = true,
        enabled: Boolean = true,
        hint: String? = null,
        editable: Boolean = false,
        clickable: Boolean = false,
        focused: Boolean = false,
        password: Boolean = false,
        className: String? = "android.widget.TextView",
        path: String = "0",
        windowId: Int = 7,
        scrollable: Boolean = false,
        checkable: Boolean = false,
        checked: Boolean = false,
    ) = Node(
        text, desc, id, visible, enabled, target, hint, editable, clickable, focused, password,
        className, path, windowId, scrollable, checkable, checked,
    )

    // --- normalize ---

    @Test fun normalizeDropsMarksAndNiqqudAndSplitsWords() {
        assertEquals("שלח", ScreenLogic.normalize("‏שְׁלַח"))
        assertEquals("btn delete item", ScreenLogic.normalize("btnDeleteItem"))
        assertEquals("confirm order", ScreenLogic.normalize("confirm_order"))
        assertEquals("ok", ScreenLogic.normalize("  OK!! "))
        // NFC: e + combining acute is one letter.
        assertEquals("café", ScreenLogic.normalize("café"))
    }

    // --- risk ---

    @Test fun theHigherClassWins() {
        val safe = Cls.SAFE to null
        val unsure = Cls.UNCERTAIN to Why.GENERIC
        val sensitive = Cls.SENSITIVE to Why.SENSITIVE
        assertEquals(unsure, ScreenLogic.higher(safe, unsure))
        assertEquals(sensitive, ScreenLogic.higher(sensitive, unsure))
        assertEquals(unsure, ScreenLogic.higher(unsure, Cls.UNCERTAIN to Why.AFTER_FORM))
    }

    @Test fun anUnknownActionIsTheHighestRisk() {
        assertEquals(Cls.SENSITIVE, ScreenLogic.riskClass("swipe", null, false, false).first)
    }

    @Test fun thePhoneReadsTheWholeLabelNotTheCutOne() {
        // The sensitive word sits past character 80: the server never saw it, the phone does.
        val long = "א".repeat(90) + " שלח"
        val nodes = listOf(node(text = long, clickable = true, target = 0))
        assertEquals(80, ScreenLogic.elements(nodes, pkg)[0].t!!.length)
        assertEquals(Cls.SENSITIVE to Why.SENSITIVE, ScreenLogic.ownClass("tap", nodes, 0, pkg, false, false))
    }

    @Test fun thePhoneAlsoReadsTheDescriptionBehindAText() {
        val nodes = listOf(node(text = "המשך לקופה", desc = "Checkout", clickable = true, target = 0))
        assertEquals(Cls.SENSITIVE, ScreenLogic.ownClass("tap", nodes, 0, pkg, false, false).first)
        val plain = listOf(node(text = "סטימצקי", clickable = true, target = 0))
        assertEquals(Cls.SAFE to null, ScreenLogic.ownClass("tap", plain, 0, pkg, false, false))
    }

    @Test fun searchFieldsAreFoundByHintIdOrLabel() {
        assertTrue(ScreenLogic.isSearchField(ScreenLogic.Element(h = "חפש מוצר", f = "ce")))
        assertTrue(ScreenLogic.isSearchField(ScreenLogic.Element(v = "search_src_text", f = "e")))
        assertFalse(ScreenLogic.isSearchField(ScreenLogic.Element(h = "שם מלא", f = "e")))
        assertFalse(ScreenLogic.isSearchField(null))
    }

    // --- elements ---

    @Test fun actionableNodesAndFreeTextsBecomeElements() {
        val nodes = listOf(
            node(className = "android.widget.FrameLayout", path = ""), // 0: a container, no text
            node(text = "תוצאות החיפוש", path = "0"), // 1: free text → read-only
            node(clickable = true, id = "il.co.fid:id/row", className = "android.widget.LinearLayout", path = "1"), // 2
            node(text = "סטימצקי", target = 2, path = "1.0"), // 3: under 2 → its label
            node(text = "דיזנגוף", target = 2, path = "1.1"), // 4
            node(editable = true, clickable = true, hint = "חפש", target = 5, focused = true, className = "android.widget.EditText", path = "2"), // 5
            node(text = "נסתר", visible = false, path = "3"), // 6: invisible
            node(scrollable = true, className = "androidx.recyclerview.widget.RecyclerView", path = "4"), // 7
        )
        val list = ScreenLogic.elements(nodes, pkg)
        assertEquals(4, list.size)
        assertEquals(listOf(0, 1, 2, 3), list.map { it.i })

        val text = list[0]
        assertEquals("תוצאות החיפוש", text.t)
        assertEquals("", text.f)
        assertNull(text.b)

        val row = list[1]
        assertEquals("סטימצקי · דיזנגוף", row.t)
        assertEquals("row", row.v)
        assertEquals("LinearLayout", row.c)
        assertEquals("c", row.f)
        assertEquals(32, row.b!!.length)

        val field = list[2]
        assertEquals("חפש", field.h)
        assertEquals("ceo", field.f)
        assertEquals("EditText", field.c)

        assertEquals("s", list[3].f)
        assertEquals("RecyclerView", list[3].c)
        assertTrue(list[3].b != null)
    }

    @Test fun flagsKeepTheWireOrder() {
        val all = node(clickable = true, editable = true, scrollable = true, checkable = true, checked = true, enabled = false, focused = true)
        assertEquals("ceskxdo", ScreenLogic.flags(all))
        assertTrue(Regex("^c?e?s?k?x?d?o?$").matches(ScreenLogic.flags(all)))
        assertEquals("kx", ScreenLogic.flags(node(checkable = true, checked = true)))
    }

    @Test fun aPasswordFieldNeverSendsItsText() {
        val nodes = listOf(node(text = "secret", editable = true, clickable = true, password = true, target = 0, hint = "סיסמה"))
        val element = ScreenLogic.elements(nodes, pkg).single()
        assertNull(element.t)
        assertEquals("סיסמה", element.h)
    }

    @Test fun labelsAreCutTo80WithoutSplittingAnEmoji() {
        val long = "א".repeat(79) + "😀" + "ב".repeat(10)
        val element = ScreenLogic.elements(listOf(node(text = long, clickable = true, target = 0)), pkg).single()
        assertEquals(79, element.t!!.length)
        assertEquals(80, ScreenLogic.cut("x".repeat(200)).length)
    }

    @Test fun elementsStopAt80() {
        val nodes = List(120) { node(text = "פריט $it", clickable = true, target = it, path = "$it") }
        val list = ScreenLogic.elements(nodes, pkg)
        assertEquals(ScreenLogic.MAX_ELEMENTS, list.size)
        assertEquals(79, list.last().i)
    }

    @Test fun elementsStopBeforeTheCharactersPass2500() {
        // 40 characters each: 62 fit (2,480), the 63rd would make 2,520.
        val nodes = List(70) { node(text = "x".repeat(40), clickable = true, target = it, path = "$it") }
        val list = ScreenLogic.elements(nodes, pkg)
        assertEquals(62, list.size)
        assertTrue(list.sumOf { it.t!!.length } <= ScreenLogic.MAX_SCREEN_CHARS)
    }

    @Test fun aScreenIsUsableOnlyWithALabelledClickable() {
        val thin = listOf(
            ScreenLogic.Element(i = 0, t = "כותרת", f = ""),
            ScreenLogic.Element(i = 1, f = "c", b = "0".repeat(32)),
        )
        assertFalse(ScreenLogic.usable(thin))
        assertTrue(ScreenLogic.usable(thin + ScreenLogic.Element(i = 2, v = "menu", f = "c", b = "1".repeat(32))))
        assertTrue(ScreenLogic.usable(listOf(ScreenLogic.Element(i = 0, t = "סטימצקי", f = "c", b = "2".repeat(32)))))
        assertFalse(ScreenLogic.usable(emptyList()))
    }

    @Test fun theScreenHashFollowsTextFlagsAndBindings() {
        val a = listOf(ScreenLogic.Element(i = 0, t = "סטימצקי", f = "c", b = "0".repeat(32)))
        val hash = ScreenLogic.screenHash(a)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(hash))
        assertEquals(hash, ScreenLogic.screenHash(a.toList()))
        assertNotEquals(hash, ScreenLogic.screenHash(listOf(a[0].copy(f = "cd"))))
        assertNotEquals(hash, ScreenLogic.screenHash(listOf(a[0].copy(t = "סטימצקי 2"))))
        assertNotEquals(hash, ScreenLogic.screenHash(listOf(a[0].copy(b = "1".repeat(32)))))
    }

    // --- binding ---

    private val button = node(text = "סטימצקי", clickable = true, target = 0, className = "android.widget.Button", path = "0.3", windowId = 7)

    @Test fun aBindingFindsExactlyItsNode() {
        val other = button.copy(text = "צומת ספרים", path = "0.4")
        val b = ScreenLogic.binding(button, pkg)
        assertTrue(Regex("^[0-9a-f]{32}$").matches(b))
        assertEquals(Pick.One(0), ScreenLogic.resolveBinding(listOf(button, other), b, pkg))
        assertEquals(Pick.One(1), ScreenLogic.resolveBinding(listOf(other, button), b, pkg))
    }

    @Test fun twoIdenticalNodesAreAmbiguous() {
        val b = ScreenLogic.binding(button, pkg)
        assertEquals(Pick.Many(2), ScreenLogic.resolveBinding(listOf(button, button.copy()), b, pkg))
    }

    @Test fun aNewWindowFindsNothing() {
        val b = ScreenLogic.binding(button, pkg)
        assertEquals(Pick.None, ScreenLogic.resolveBinding(listOf(button.copy(windowId = 8)), b, pkg))
    }

    @Test fun aToggleThatFlippedFindsNothing() {
        val toggle = node(desc = "התראות", clickable = true, checkable = true, checked = false, target = 0, className = "android.widget.Switch")
        val b = ScreenLogic.binding(toggle, pkg)
        assertEquals(Pick.None, ScreenLogic.resolveBinding(listOf(toggle.copy(checked = true)), b, pkg))
    }

    @Test fun aFieldStillMatchesAfterTyping() {
        val field = node(editable = true, clickable = true, hint = "חפש", id = "il.co.fid:id/search", target = 0, className = "android.widget.EditText")
        val b = ScreenLogic.binding(field, pkg)
        assertEquals(Pick.One(0), ScreenLogic.resolveBinding(listOf(field.copy(text = "סטימצקי", focused = true)), b, pkg))
    }

    @Test fun aChangedHintFindsNothing() {
        val field = node(editable = true, hint = "חפש", target = -1, className = "android.widget.EditText")
        val b = ScreenLogic.binding(field, pkg)
        assertEquals(Pick.None, ScreenLogic.resolveBinding(listOf(field.copy(hint = "שם מלא")), b, pkg))
    }

    @Test fun enabledVisibleAndPasswordAreNotPartOfTheBinding() {
        val b = ScreenLogic.binding(button, pkg)
        assertEquals(b, ScreenLogic.binding(button.copy(enabled = false, visible = false, password = true), pkg))
        assertNotEquals(b, ScreenLogic.binding(button, "com.other.app"))
        assertNotEquals(b, ScreenLogic.binding(button.copy(text = "סטימצקי 2"), pkg))
        assertNotEquals(b, ScreenLogic.binding(button.copy(path = "0.4"), pkg))
    }

    @Test fun theBindingIsTheSpecsHash() {
        // sha256("v1␟il.co.fid␟7␟0.3␟android.widget.Button␟0␟1␟0␟0␟␟␟␟סטימצקי"), first 32 hex.
        val canonical = listOf("v1", pkg, "7", "0.3", "android.widget.Button", "0", "1", "0", "0", "", "", "", "סטימצקי")
            .joinToString("\u001f")
        assertEquals(Protocol.sha256Hex(canonical.toByteArray(Charsets.UTF_8)).take(32), ScreenLogic.binding(button, pkg))
    }

    // --- the journal (plan §9.9): every row ---

    @Test fun aNewActionMayStartBeHeldOrBeRefused() {
        assertEquals(Status.STARTED, ScreenLogic.next(null, Event.START))
        assertEquals(Status.HELD, ScreenLogic.next(null, Event.HOLD))
        assertEquals(Status.REFUSED, ScreenLogic.next(null, Event.REFUSE))
        for (e in listOf(Event.DISPATCHED, Event.NOT_ACCEPTED, Event.UNCERTAIN, Event.RESTART)) assertNull(ScreenLogic.next(null, e))
    }

    @Test fun aHeldActionStartsOnceOrIsRefused() {
        assertEquals(Status.STARTED, ScreenLogic.next(Status.HELD, Event.START))
        assertEquals(Status.REFUSED, ScreenLogic.next(Status.HELD, Event.REFUSE))
        assertEquals(Status.REFUSED, ScreenLogic.next(Status.HELD, Event.RESTART))
        for (e in listOf(Event.HOLD, Event.DISPATCHED, Event.NOT_ACCEPTED, Event.UNCERTAIN)) assertNull(ScreenLogic.next(Status.HELD, e))
        // Once started it is no longer held: a second start is refused.
        assertNull(ScreenLogic.next(ScreenLogic.next(Status.HELD, Event.START), Event.START))
    }

    @Test fun aStartedActionEndsInAnOutcome() {
        assertEquals(Status.DISPATCHED, ScreenLogic.next(Status.STARTED, Event.DISPATCHED))
        assertEquals(Status.NOT_ACCEPTED, ScreenLogic.next(Status.STARTED, Event.NOT_ACCEPTED))
        assertEquals(Status.UNCERTAIN, ScreenLogic.next(Status.STARTED, Event.UNCERTAIN))
        assertEquals(Status.UNCERTAIN, ScreenLogic.next(Status.STARTED, Event.RESTART))
        for (e in listOf(Event.START, Event.HOLD, Event.REFUSE)) assertNull(ScreenLogic.next(Status.STARTED, e))
    }

    @Test fun aFinalStatusNeverMoves() {
        val finals = Status.entries.filter { it.final }
        assertEquals(setOf(Status.DISPATCHED, Status.NOT_ACCEPTED, Status.REFUSED, Status.UNCERTAIN), finals.toSet())
        for (status in finals) for (event in Event.entries) assertNull("$status $event", ScreenLogic.next(status, event))
    }

    // --- actions, grants, waits ---

    private val id = "a".repeat(32)

    @Test fun onlyWellShapedActionsRun() {
        assertTrue(ScreenLogic.validAction(ScreenLogic.Action("tap", id), 0))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("tap", "short"), 0))
        assertTrue(ScreenLogic.validAction(ScreenLogic.Action("type", id, input = 2), 2))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("type", id, input = 3), 2)) // no third input was claimed
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("type", id, input = 0), 3))
        assertTrue(ScreenLogic.validAction(ScreenLogic.Action("scroll", id, dir = "back"), 0))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("scroll", id, dir = "up"), 0))
        assertTrue(ScreenLogic.validAction(ScreenLogic.Action("back"), 0))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("back", id), 0))
        assertTrue(ScreenLogic.validAction(ScreenLogic.Action("wait", seconds = 5), 0))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("wait", seconds = 6), 0))
        assertFalse(ScreenLogic.validAction(ScreenLogic.Action("swipe", id), 0))
    }

    @Test fun aGrantMustMatchAndBeFresh() {
        val task = "b".repeat(32)
        val action = ScreenLogic.Action("tap", id)
        val grant = ScreenLogic.Grant(task, 3, "c".repeat(32), id, pkg, Cls.UNCERTAIN, expiresAt = 1_000L)
        fun problem(g: ScreenLogic.Grant = grant, own: Cls = Cls.UNCERTAIN, now: Long = 500L) =
            ScreenLogic.grantProblem(g, task, 3, "c".repeat(32), action, pkg, own, now)
        assertNull(problem())
        assertNull(problem(own = Cls.SAFE))
        assertEquals("not_allowed", problem(own = Cls.SENSITIVE))
        assertEquals("not_allowed", problem(grant.copy(step = 4)))
        assertEquals("not_allowed", problem(grant.copy(binding = "d".repeat(32))))
        assertEquals("not_allowed", problem(grant.copy(packageName = "com.other.app")))
        assertEquals("not_allowed", problem(grant.copy(actionId = "e".repeat(32))))
        assertEquals("deadline", problem(now = 1_000L))
    }

    @Test fun pollsBackOffAndWaitsAreClamped() {
        assertEquals(listOf(3_000L, 5_000L, 8_000L, 10_000L, 10_000L), (0..4).map { ScreenLogic.pollDelayMs(it) })
        assertEquals(2_000L, ScreenLogic.retryDelayMs(10))
        assertEquals(15_000L, ScreenLogic.retryDelayMs(60_000))
        assertEquals(7_000L, ScreenLogic.retryDelayMs(7_000))
    }

    @Test fun thePhonesDeadlineIsTheEarlierOne() {
        // The server's deadline is 4 minutes away: 4 minutes.
        assertEquals(1_000L + 240_000L, ScreenLogic.phoneDeadline(1_000L, 0L, 240_000L))
        // Further than 4 minutes (clocks apart): still 4 minutes from the claim.
        assertEquals(1_000L + 240_000L, ScreenLogic.phoneDeadline(1_000L, 0L, 900_000L))
        // Sooner: the server's.
        assertEquals(1_000L + 60_000L, ScreenLogic.phoneDeadline(1_000L, 0L, 60_000L))
        // Already past: now.
        assertEquals(1_000L, ScreenLogic.phoneDeadline(1_000L, 500_000L, 60_000L))
    }

    @Test fun unknownEndCodesAreSentAsError() {
        assertEquals("left_app", ScreenLogic.endCode("left_app"))
        assertEquals("error", ScreenLogic.endCode("tap_refused"))
        assertEquals(16, ScreenLogic.END_CODES.size)
    }

    // --- the allowlist ---

    @Test fun settingsMessagingBanksAndLaunchersAreBlocked() {
        val own = "com.tzur.callcompanion"
        for (blocked in listOf(
            own, "com.android.settings", "com.android.systemui", "com.whatsapp", "org.telegram.messenger",
            "org.thoughtcrime.securesms", "com.google.android.apps.messaging", "com.samsung.android.messaging",
            "com.google.android.gm", "com.ideomobile.hapoalim", "com.leumi.leumiwallet", "com.MizrahiTefahot.nh",
            "com.fibi.nativeapp", "com.bnhp.payments.paymentsapp", "com.payboxapp",
            "com.google.android.apps.walletnfcrel", "com.example.mybank", "com.android.keyguard",
            "com.sec.android.app.launcher", "com.example.sms",
        )) {
            assertTrue(blocked, ScreenLogic.blocked(blocked, own))
        }
        assertTrue(ScreenLogic.blocked("com.example.home", own, launchers = setOf("com.example.home")))
        assertFalse(ScreenLogic.blocked("il.co.fid", own))
        assertFalse(ScreenLogic.blocked("com.spotify.music", own))
    }

    // --- opening the app ---

    @Test fun routinesStillClearTheTaskAndScreenTasksDoNot() {
        // Intent.FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK, as Android defines them.
        assertEquals(0x10000000 or 0x00008000, RoutineLogic.launchFlags(fresh = true))
        assertEquals(0x10000000, RoutineLogic.launchFlags(fresh = false))
    }
}
