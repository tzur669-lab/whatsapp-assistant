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
        /**
         * The assistant needs the phone to read something first (PLAN §6.21).
         * The answer to [queryId] continues the turn; the same message sent
         * again gets the same query back until then.
         */
        class DeviceQuery(val queryId: String, val query: JSONObject) : Answer()
    }

    sealed class PairResult {
        class Paired(val deviceId: String) : PairResult()
        object Refused : PairResult()
        object Unreachable : PairResult()
    }

    class Page(val rows: List<Row>, val more: Boolean)

    class Dispatch(val queryVariants: List<String>, val expiresAt: Long)

    /** What the server says to a claim on a card (PLAN §6.20). */
    sealed class Claim {
        /** Consumed: this is what to run. The server will not hand it out again. */
        class Ok(val action: JSONObject) : Claim()
        object Cancelled : Claim()
        /** `expired`, `used`, or `not_found`. */
        class Refused(val reason: String) : Claim()
        object Unreachable : Claim()
    }

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

    // Each carries the conversation it was written in, when it is a real one
    // (ChatLogic.wireConversation): the server keeps its memory per conversation.

    // A typed or spoken message may carry where the phone is (0.8): coarse,
    // for the weather, read once before the first attempt and reused on retries,
    // with the town's name when the phone's geocoder found one.

    fun sendText(
        context: Context,
        messageId: String,
        text: String,
        conversation: String?,
        location: LocationLogic.Coarse? = null,
    ): Pair<Result, Answer?> {
        val body = JSONObject().put("id", messageId).put("kind", "text").put("text", text)
        ChatLogic.wireConversation(conversation)?.let { body.put("conversationId", it) }
        location?.let {
            val place = JSONObject().put("latitude", it.latitude).put("longitude", it.longitude)
            it.name?.let { name -> place.put("name", name) }
            body.put("location", place)
        }
        return answerOf(signed(context, "POST", "/app/message", JSON_TYPE, utf8(body), TEXT_TIMEOUT_MS))
    }

    fun sendButton(context: Context, messageId: String, buttonId: String, conversation: String?): Pair<Result, Answer?> {
        require(Protocol.BUTTON_ID.matches(buttonId))
        val body = JSONObject().put("id", messageId).put("kind", "button").put("buttonId", buttonId)
        ChatLogic.wireConversation(conversation)?.let { body.put("conversationId", it) }
        return answerOf(signed(context, "POST", "/app/message", JSON_TYPE, utf8(body), TEXT_TIMEOUT_MS))
    }

    fun sendVoice(
        context: Context,
        messageId: String,
        audio: ByteArray,
        conversation: String?,
        location: LocationLogic.Coarse? = null,
    ): Pair<Result, Answer?> {
        require(Protocol.MESSAGE_ID.matches(messageId))
        // The body is the recording itself, so the conversation and the place go in the (signed) path.
        val base = ChatLogic.wireConversation(conversation)?.let { "/app/voice/$messageId/$it" } ?: "/app/voice/$messageId"
        val path = location?.let { "$base/${LocationLogic.pathSegment(it)}" } ?: base
        return answerOf(signed(context, "POST", path, AUDIO_TYPE, audio, VOICE_TIMEOUT_MS))
    }

    /** The quota screen's numbers (0.6). Null when the server could not be asked or answered off-shape. */
    fun fetchQuota(context: Context): QuotaLogic.Report? {
        val json = (signed(context, "GET", "/app/quota", null, ByteArray(0), SHORT_TIMEOUT_MS) as? Result.Ok)?.json
            ?: return null
        return try {
            fun bucket(o: JSONObject?): QuotaLogic.Bucket? = o?.let {
                QuotaLogic.Bucket(it.getLong("limit"), it.getLong("remaining"), it.getLong("resetAt"), it.getLong("observedAt"))
            }
            fun counted(o: JSONObject?): QuotaLogic.Counted? = o?.let { QuotaLogic.Counted(it.getLong("limit"), it.getLong("used")) }

            val models = json.getJSONArray("models")
            val worker = json.getJSONObject("workerRequests")
            QuotaLogic.Report(
                at = json.getLong("at"),
                models = List(models.length()) { i ->
                    val m = models.getJSONObject(i)
                    QuotaLogic.Model(
                        model = m.getString("model"),
                        role = m.getString("role"),
                        requests = bucket(m.optJSONObject("requests")),
                        minuteTokens = bucket(m.optJSONObject("minuteTokens")),
                        dayTokens = counted(m.optJSONObject("dayTokens")),
                    )
                },
                voice = counted(json.getJSONObject("voice"))!!,
                workerRequests = QuotaLogic.Counted(worker.getLong("limit"), worker.getLong("used")),
                workerResetAt = worker.getLong("resetAt"),
                server = json.optJSONObject("server")?.let { server ->
                    fun longOrNull(o: JSONObject, key: String): Long? = if (o.isNull(key)) null else o.getLong(key)
                    val minute = server.getJSONArray("minute")
                    val failure = server.optJSONObject("lastFailure")
                    QuotaLogic.Server(
                        minute = List(minute.length()) { i ->
                            val m = minute.getJSONObject(i)
                            QuotaLogic.ServerMinute(
                                model = m.getString("model"),
                                used = m.getLong("used"),
                                limit = m.getLong("limit"),
                                freesAt = longOrNull(m, "freesAt"),
                                blockedUntil = longOrNull(m, "blockedUntil"),
                            )
                        },
                        turnTokenCap = server.getLong("turnTokenCap"),
                        lastFailureCode = failure?.getString("code"),
                        lastFailureAt = failure?.let { longOrNull(it, "at") },
                        fallbacksToday = server.getLong("fallbacksToday"),
                    )
                },
            )
        } catch (_: Exception) {
            null
        }
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

    /** What this build can do, sent with the push address (PLAN §6.20, §6.21). */
    val CAPS = listOf("cards", "device_query")

    fun updatePushToken(context: Context, pushToken: String): Boolean {
        val body = JSONObject().put("pushToken", pushToken).put("caps", JSONArray(CAPS))
        return signed(context, "POST", "/app/push-token", JSON_TYPE, utf8(body), SHORT_TIMEOUT_MS) is Result.Ok
    }

    // -- action cards (PLAN §6.20) --------------------------------------------

    /** `verb`: ok runs it, no refuses it. Either way the card is spent. */
    fun claim(context: Context, card: Row.Card, verb: String): Claim {
        require(verb == "ok" || verb == "no")
        val body = JSONObject().put("actionId", card.actionId).put("nonce", card.nonce).put("verb", verb)
        val json = when (val result = signed(context, "POST", "/app/action/claim", JSON_TYPE, utf8(body), SHORT_TIMEOUT_MS)) {
            is Result.Ok -> result.json ?: return Claim.Refused("not_found")
            is Result.Unreachable -> return Claim.Unreachable
            else -> return Claim.Refused("not_found")
        }
        return when (json.optString("status")) {
            "ok" -> json.optJSONObject("action")?.let { Claim.Ok(it) } ?: Claim.Refused("not_found")
            "cancelled" -> Claim.Cancelled
            else -> Claim.Refused(json.optString("reason", "not_found"))
        }
    }

    /** `outcome`: done | failed | no_match | unsupported. Never what was matched. */
    fun reportAction(context: Context, actionId: String, outcome: String): Boolean {
        val body = JSONObject().put("actionId", actionId).put("outcome", outcome)
        return signed(context, "POST", "/app/action/report", JSON_TYPE, utf8(body), SHORT_TIMEOUT_MS) is Result.Ok
    }

    // -- phone reads (PLAN §6.21) ---------------------------------------------

    /** The phone's answer to a read. Answered like a message: the reply, or pending. */
    fun deviceResult(context: Context, queryId: String, result: JSONObject): Pair<Result, Answer?> {
        require(QUERY_ID.matches(queryId))
        val body = JSONObject().put("queryId", queryId).put("result", result)
        return answerOf(signed(context, "POST", "/app/device-result", JSON_TYPE, utf8(body), TEXT_TIMEOUT_MS))
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
            "device_query" -> {
                val queryId = json.optString("queryId")
                val query = json.optJSONObject("query")
                if (QUERY_ID.matches(queryId) && query != null) Answer.DeviceQuery(queryId, query) else null
            }
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
    private val QUERY_ID = Regex("^[0-9a-f]{32}$")
}
