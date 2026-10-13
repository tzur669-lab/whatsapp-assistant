package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The service may perform gestures and lock the phone only for the stored-PIN
 * unlock (0.17): `dispatchGesture` only in `press`, `GLOBAL_ACTION_LOCK_SCREEN`
 * only in `relock`, and nowhere else in the app. The screen agent's promise —
 * no coordinates, no gestures — holds by this test, not by the service config.
 */
class UnlockScanTest {
    private val sources: List<File> = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(6)
        .flatMap { sequenceOf(File(it, "app/src/main/java/com/tzur/callcompanion"), File(it, "src/main/java/com/tzur/callcompanion")) }
        .first { it.isDirectory }
        .listFiles { f -> f.name.endsWith(".kt") }!!
        .toList()

    /** File and function of every code line (not a comment) matching [pattern]. */
    private fun usesOf(pattern: String): Set<String> = sources.flatMap { file ->
        var current = "?"
        file.readLines().mapNotNull { line ->
            // Members of the file's class or object only: a callback's own `fun` stays inside its member.
            Regex("""^ {4}(?:(?:private|internal|override|public)\s+)*fun\s+(\w+)""").find(line)?.let { current = it.groupValues[1] }
            val code = line.substringBefore("//").trim()
            if (code.startsWith("*") || code.startsWith("/*")) return@mapNotNull null
            if (Regex(pattern).containsMatchIn(code)) "${file.name}:$current" else null
        }
    }.toSet()

    @Test fun gesturesOnlyPressAKey() {
        assertEquals(setOf("RoutineAccessibilityService.kt:press"), usesOf("""\bdispatchGesture\b"""))
    }

    @Test fun lockingOnlyAfterAnUnlock() {
        assertEquals(setOf("RoutineAccessibilityService.kt:relock"), usesOf("""\bGLOBAL_ACTION_LOCK_SCREEN\b"""))
        assertEquals(
            setOf("RoutineAccessibilityService.kt:startUnlockAndRun"),
            usesOf("""\brelock\(""") - "RoutineAccessibilityService.kt:relock",
        )
    }

    @Test fun onlyTheRunnerReadsThePin() {
        assertEquals(setOf("RoutineRunner.kt:claimFirst"), usesOf("""\breadPin\(""").filterNot { it.startsWith("UnlockStore.kt") }.toSet())
    }
}
