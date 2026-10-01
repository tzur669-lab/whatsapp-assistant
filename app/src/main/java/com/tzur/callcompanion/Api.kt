package com.tzur.callcompanion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/**
 * The routes the Worker exposes to the paired phone (PLAN §6.18).
 *
 * Every request after pairing is signed with the Keystore key over the
 * canonical string ([Protocol.canonical]); the body is written from the very
 * array that was hashed. A 409 is a nonce the server has seen — answered by
 * signing again with a fresh one. A 401 `unpaired` means the server no longer
 * knows this phone, and the identity is dropped so the app asks to pair.
 *
 * Blocking calls: run them off the main thread.
 */
object Api {
    /** A typed message gets a minute: two model calls, a calendar call and a token refresh, at worst. */
    const val TEXT_TIMEOUT_MS = 60_000
    /** A recording adds the upload and Whisper. */
    const val VOICE_TIMEOUT_MS = 90_000
    /** Inside a push, the whole wake-up has about ten seconds. */
    const val PUSH_TIMEOUT_MS = 8_000
    const val SHORT_TIMEOUT_MS = 20_000

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val MAX_RESPONSE_BYTES = 2 * 1024 * 1024
    private const val SIGN_ATTEMPTS = 3

    sealed class Result {
        class Ok(val json: JSONObject?) : Result()
        /** The server does not know this phone. The identity is already forgotten. */
        object Unpaired : Result()
        /** The phone's clock is more than five minutes off. */
        object Clock : Result()
        /** No answer at all: no network, a timeout, a dropped connection. */
        object Unreachable : Result()
        class Refused(val status: Int, val code: String?) : Result()
    }

    /** What the server says about one message (§6.18). */
    sealed class Answer {
        class Reply(val row: Row) : Answer()
        /** The turn finished and had nothing to say. */
        object Done : Answer()
        /** The first attempt is still running. Its answer will be in the outbox. */
        object Pending : Answer()
        /** Recorded long ago and never finished: it may or may not have happened. */
        object Unknown : Answer()
    }

    sealed class PairResult {
        class Paired(val deviceId: String) : PairResult()
        object Refused : PairResult()
        object Unreachable : PairResult()
    }

    class Page(val rows: List<Row>, val more: Boolean)

    class Dispatch(val queryVariants: List<String>, val expiresAt: Long)

    // -- pairing (unsigned: the MAC is the proof) -----------------------------

    fun pair(publicKey: String, pushToken: String, timestamp: Long, mac: String): PairResult {
        val body = JSONObject()
            .put("publicKey", publicKey)
            .put("pushToken", pushToken)
            .put("timestamp", timestamp)
            .put("mac", mac)
            .toString()
            .toByteArray(Charsets.UTF_8)
        return try {
            val (status, text) = http("POST", "/app/pair", emptyMap(), JSON_TYPE, body, SHORT_TIMEOUT_MS)
            val deviceId = if (status == 200) json(text)?.optString("deviceId") else null
            if (deviceId != null && Protocol.DEVICE_ID.matches(deviceId)) PairResult.Paired(deviceId) else PairResult.Refused
        } catch (_: IOException) {
            PairResult.Unreachable
        }
    }

    // -- the conversation -----------------------------------------------------

    fun sendText(context: Context, messageId: String, text: String): Pair<Result, Answer?> {
        val body = JSONObject().put("id", messageId).put("kind", "text").put("text", text)
        return answerOf(signed(context, "POST", "/app/message", JSON_TYPE, utf8(body), TEXT_TIMEOUT_MS))
    }

    fun sendButton(context: Context, messageId: String, buttonId: String): Pair<Result, Answer?> {
        require(Protocol.BUTTON_ID.matches(buttonId))
        val body = JSONObject().put("id", messageId).put("kind", "button").put("buttonId", buttonId)
        return answerOf(signed(context, "POST", "/app/message", JSON_TYPE, utf8(body), TEXT_TIMEOUT_MS))
    }

    fun sendVoice(context: Context, messageId: String, audio: ByteArray): Pair<Result, Answer?> {
        require(Protocol.MESSAGE_ID.matches(messageId))
        return answerOf(signed(context, "POST", "/app/voice/$messageId", AUDIO_TYPE, audio, VOICE_TIMEOUT_MS))
    }

    /** One page of what the phone has not acked yet. */
    fun fetchOutbox(context: Context, timeoutMs: Int): Pair<Result, Page?> {
        val result = signed(context, "GET", "/app/outbox", null, ByteArray(0), timeoutMs)
        val json = (result as? Result.Ok)?.json ?: return result to null
        val rows = json.optJSONArray("rows") ?: return result to null
        val parsed = (0 until rows.length()).mapNotNull { Row.from(rows.optJSONObject(it)) }
        return result to Page(parsed, json.optBoolean("more", false))
    }

    /** These rows are committed on the phone. Only these: never "everything up to". */
    fun ack(context: Context, seqs: List<Long>, timeoutMs: Int): Boolean {
        if (seqs.isEmpty()) return true
        val body = JSONObject().put("seqs", JSONArray(seqs))
        return signed(context, "POST", "/app/outbox/ack", JSON_TYPE, utf8(body), timeoutMs) is Result.Ok
    }

    fun updatePushToken(context: Context, pushToken: String): Boolean {
        val body = JSONObject().put("pushToken", pushToken)
        return signed(context, "POST", "/app/push-token", JSON_TYPE, utf8(body), SHORT_TIMEOUT_MS) is Result.Ok
    }

    // -- calls (PLAN §6.17) ---------------------------------------------------

    /** Null when the request is unknown, expired, not this device's, or unreachable. */
    fun fetchDispatch(context: Context, dispatchId: String): Dispatch? {
        if (!DISPATCH_ID.matches(dispatchId)) return null
        val json = (signed(context, "GET", "/device/dispatch/$dispatchId", null, ByteArray(0), PUSH_TIMEOUT_MS) as? Result.Ok)
            ?.json ?: return null
        return try {
            val variants = json.getJSONArray("queryVariants")
            Dispatch(List(variants.length()) { variants.getString(it) }, json.getLong("expiresAt"))
        } catch (_: Exception) {
            null
        }
    }

    /** `matched`: none | one | many. `outcome`: placed | cancelled | no_match. */
    fun report(context: Context, dispatchId: String, matched: String, outcome: String): Boolean {
        val body = JSONObject().put("dispatchId", dispatchId).put("matched", matched).put("outcome", outcome)
        return signed(context, "POST", "/device/report", JSON_TYPE, utf8(body), SHORT_TIMEOUT_MS) is Result.Ok
    }

    // -- plumbing -------------------------------------------------------------

    private fun answerOf(result: Result): Pair<Result, Answer?> {
        val json = (result as? Result.Ok)?.json ?: return result to null
        val answer = when (json.optString("status")) {
            "reply" -> Row.from(json.optJSONObject("row"))?.let { Answer.Reply(it) }
            "done" -> Answer.Done
            "pending" -> Answer.Pending
            "unknown" -> Answer.Unknown
            else -> null
        }
        return result to answer
    }

    /**
     * Sign and send. The array hashed into the signature is the array written
     * to the socket, so the server's hash of what it received matches.
     */
    private fun signed(
        context: Context,
        method: String,
        path: String,
        contentType: String?,
        body: ByteArray,
        timeoutMs: Int,
    ): Result {
        val signer = Signer(context)
        repeat(SIGN_ATTEMPTS) {
            val deviceId = signer.deviceId ?: return Result.Unpaired
            val timestamp = System.currentTimeMillis()
            val nonce = Protocol.newNonce()
            val signature = signer.sign(Protocol.canonical(method, path, deviceId, timestamp, nonce, body))
                ?: return Result.Unpaired
            val headers = mapOf(
                "x-device-id" to deviceId,
                "x-timestamp" to timestamp.toString(),
                "x-nonce" to nonce,
                "x-signature" to Base64.getEncoder().encodeToString(signature),
            )

            val (status, text) = try {
                http(method, path, headers, contentType, body, timeoutMs)
            } catch (_: IOException) {
                return Result.Unreachable
            }
            val json = json(text)
            when {
                status in 200..299 -> return Result.Ok(json)
                status == 409 -> Unit // a nonce seen before: sign again with a new one
                status == 401 -> {
                    if (json?.optString("error") == "clock") return Result.Clock
                    // `unpaired`, or a signature the server cannot verify with the
                    // key it holds: either way this key is done. Pair again.
                    signer.forget()
                    return Result.Unpaired
                }
                else -> return Result.Refused(status, json?.optString("error"))
            }
        }
        return Result.Refused(409, "replay")
    }

    private fun http(
        method: String,
        path: String,
        headers: Map<String, String>,
        contentType: String?,
        body: ByteArray,
        timeoutMs: Int,
    ): Pair<Int, String> {
        val connection = URL(BuildConfig.SERVER_URL + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = minOf(CONNECT_TIMEOUT_MS, timeoutMs)
            connection.readTimeout = timeoutMs
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (method == "POST") {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", contentType ?: JSON_TYPE)
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { readCapped(it) } ?: ""
            return status to text
        } finally {
            connection.disconnect()
        }
    }

    private fun readCapped(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8_192)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > MAX_RESPONSE_BYTES) throw IOException("response too large")
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun json(text: String): JSONObject? = try {
        if (text.startsWith("{")) JSONObject(text) else null
    } catch (_: Exception) {
        null
    }

    private fun utf8(json: JSONObject): ByteArray = json.toString().toByteArray(Charsets.UTF_8)

    private const val JSON_TYPE = "application/json"
    private const val AUDIO_TYPE = "audio/mp4"
    private val DISPATCH_ID = Regex("^[0-9a-f]{32}$")
}
