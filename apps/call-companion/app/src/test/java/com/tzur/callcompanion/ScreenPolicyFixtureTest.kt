package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The risk policy is kept twice, here and in the server's
 * `src/agent/screen-policy.ts`; both are checked against one file,
 * `test/fixtures/screen-policy.json`. If the lists drift or a vector's class
 * changes, this fails. The file is found by walking up from the working
 * directory, like `RoutineReasonsTest`; without it (a lone app checkout) the
 * test is skipped.
 */
class ScreenPolicyFixtureTest {

    @Suppress("UNCHECKED_CAST")
    private fun fixture(): Map<String, Any?>? {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .take(6)
            .map { File(it, "test/fixtures/screen-policy.json") }
            .firstOrNull { it.isFile } ?: return null
        return MiniJson.parse(file.readText(Charsets.UTF_8)) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private fun list(map: Map<String, Any?>, key: String): List<String> = map[key] as List<String>

    @Test fun `the word lists equal the shared file's`() {
        val file = fixture()
        assumeTrue("the shared fixture is not in this checkout", file != null)
        assertEquals(list(file!!, "sensitive"), ScreenLogic.SENSITIVE)
        assertEquals(list(file, "generic"), ScreenLogic.GENERIC)
        assertEquals(list(file, "search"), ScreenLogic.SEARCH)
    }

    @Suppress("UNCHECKED_CAST")
    @Test fun `every vector gets its class and reason`() {
        val file = fixture()
        assumeTrue("the shared fixture is not in this checkout", file != null)
        val vectors = file!!["vectors"] as List<Map<String, Any?>>
        assertTrue(vectors.size >= 20)
        val failures = vectors.mapNotNull { vector ->
            val el = (vector["el"] as Map<String, Any?>?)?.let {
                ScreenLogic.Element(t = it["t"] as String?, h = it["h"] as String?, v = it["v"] as String?, f = (it["f"] as String?) ?: "")
            }
            val ctx = vector["ctx"] as Map<String, Any?>
            val (cls, why) = ScreenLogic.riskClass(
                vector["action"] as String,
                el,
                askEveryTap = ctx["askEveryTap"] == true,
                typedNonSearch = ctx["typedNonSearch"] == true,
            )
            val want = "${vector["cls"]}/${vector["why"]}"
            val got = "${cls.wire}/${why?.wire}"
            if (want == got) null else "${vector["name"]}: wanted $want, got $got"
        }
        assertEquals(emptyList<String>(), failures)
    }
}

/** Just enough JSON for the fixture: objects, arrays, strings (with \u escapes), numbers, true, false, null. */
internal object MiniJson {
    fun parse(text: String): Any? {
        val reader = Reader(text)
        val value = reader.value()
        reader.space()
        require(reader.done()) { "trailing characters at ${reader.at}" }
        return value
    }

    private class Reader(val s: String) {
        var at = 0

        fun done() = at >= s.length

        fun space() {
            while (at < s.length && s[at].isWhitespace()) at++
        }

        fun value(): Any? {
            space()
            return when (val c = s[at]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || c.isDigit()) num() else error("unexpected '$c' at $at")
            }
        }

        private fun word(w: String, v: Any?): Any? {
            require(s.startsWith(w, at)) { "bad literal at $at" }
            at += w.length
            return v
        }

        private fun num(): Number {
            val start = at
            while (at < s.length && (s[at].isDigit() || s[at] in "+-.eE")) at++
            val t = s.substring(start, at)
            return if (t.any { it in ".eE" }) t.toDouble() else t.toLong()
        }

        private fun str(): String {
            at++ // opening quote
            val out = StringBuilder()
            while (true) {
                val c = s[at++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        when (val e = s[at++]) {
                            'n' -> out.append('\n')
                            't' -> out.append('\t')
                            'r' -> out.append('\r')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'u' -> {
                                out.append(s.substring(at, at + 4).toInt(16).toChar())
                                at += 4
                            }
                            else -> out.append(e)
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        private fun arr(): List<Any?> {
            at++
            val out = ArrayList<Any?>()
            space()
            if (s[at] == ']') { at++; return out }
            while (true) {
                out.add(value())
                space()
                when (s[at++]) {
                    ',' -> continue
                    ']' -> return out
                    else -> error("expected , or ] at ${at - 1}")
                }
            }
        }

        private fun obj(): Map<String, Any?> {
            at++
            val out = LinkedHashMap<String, Any?>()
            space()
            if (s[at] == '}') { at++; return out }
            while (true) {
                space()
                val key = str()
                space()
                require(s[at++] == ':') { "expected : at ${at - 1}" }
                out[key] = value()
                space()
                when (s[at++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> error("expected , or } at ${at - 1}")
                }
            }
        }
    }
}
