package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The app's run reasons hold every one the server knows (Improvement plan §3
 * T4). A reason missing here is sent as `error`, silently. The server's list is
 * read from its source in this repository, so the two cannot drift apart.
 */
class RoutineReasonsTest {
    private fun serverReasons(): List<String>? {
        val source = generateSequence(File("").absoluteFile) { it.parentFile }
            .take(6)
            .map { File(it, "src/render/routines.ts") }
            .firstOrNull { it.isFile } ?: return null
        val block = Regex("""RUN_REASONS = \[(.*?)] as const""", RegexOption.DOT_MATCHES_ALL)
            .find(source.readText())?.groupValues?.get(1) ?: return null
        return Regex("""'([a-z_]+)'""").findAll(block).map { it.groupValues[1] }.toList()
    }

    @Test fun theAppKnowsEveryServerReason() {
        val server = serverReasons()
        assumeTrue("the server's source is not in this checkout", server != null)
        assertTrue(server!!.size >= 15)
        assertEquals(emptyList<String>(), server.filterNot { it in RoutineRunner.REASONS })
    }

    @Test fun theAppSendsNothingTheServerRefuses() {
        val server = serverReasons()
        assumeTrue("the server's source is not in this checkout", server != null)
        // An app reason the server lacks would be a 400 until the server learns it.
        assertEquals(emptyList<String>(), RoutineRunner.REASONS.filterNot { it in server!! })
    }

    @Test fun fieldChangedIsKnown() {
        assertTrue("field_changed" in RoutineRunner.REASONS)
    }
}
