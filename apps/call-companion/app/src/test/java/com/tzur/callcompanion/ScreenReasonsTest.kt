package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The screen agent's closed code lists equal the server's (0.14): the end
 * codes of `/app/screen/result` (`SCREEN_END_REASONS` in
 * `src/channels/app/parse.ts`) and the reasons a report may carry
 * (`stepReportSchema` in `src/agent/screen-step.ts`). A code the server lacks
 * is a 400 for the whole request. Skipped when the server's source is absent.
 */
class ScreenReasonsTest {
    private fun source(path: String): String? = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(6)
        .map { File(it, path) }
        .firstOrNull { it.isFile }
        ?.readText()

    private fun codes(block: String): Set<String> = Regex("""'([a-z_]+)'""").findAll(block).map { it.groupValues[1] }.toSet()

    @Test fun theEndCodesAreTheServers() {
        val parse = source("src/channels/app/parse.ts")
        val block = parse?.let { Regex("""SCREEN_END_REASONS = \[(.*?)] as const""", RegexOption.DOT_MATCHES_ALL).find(it)?.groupValues?.get(1) }
        assumeTrue("the server's source is not in this checkout", block != null)
        assertEquals(codes(block!!), ScreenLogic.END_CODES)
    }

    @Test fun theReportReasonsAreTheServers() {
        val step = source("src/agent/screen-step.ts")
        val block = step?.let {
            Regex("""stepReportSchema = z.*?reason: z\.enum\(\[(.*?)]\)""", RegexOption.DOT_MATCHES_ALL).find(it)?.groupValues?.get(1)
        }
        assumeTrue("the server's source is not in this checkout", block != null)
        assertEquals(codes(block!!), ScreenLogic.REPORT_REASONS)
    }
}
