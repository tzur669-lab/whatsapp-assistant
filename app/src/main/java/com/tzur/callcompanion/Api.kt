package com.tzur.callcompanion

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The four routes the Worker exposes to a paired phone (PLAN §6.17).
 *
 * What goes out is deliberately little: a pairing code, the push address, and
 * afterwards a dispatch id with a count and an outcome. No contact name and no
 * number ever leaves the phone — the report has no field that could carry one,
 * and the Worker refuses a report with an extra field.
 *
 * Blocking calls: run them off the main thread.
 */
object Api {
    private const val TIMEOUT_MS = 10_000
    private val DISPATCH_ID = Regex("^[0-9a-f]{32}$")

    class Dispatch(val queryVariants: List<String>, val expiresAt: Long)

    sealed class PairResult {
        class Paired(val deviceToken: String) : PairResult()
        object Refused : PairResult()
        object Unreachable : PairResult()
    }

    fun pair(code: String, pushToken: String): PairResult = try {
        val (status, body) = request("POST", "/device/pair", null, JSONObject().put("code", code).put("pushToken", pushToken))
        if (status == 200) PairResult.Paired(JSONObject(body).getString("deviceToken")) else PairResult.Refused
    } catch (_: IOException) {
        PairResult.Unreachable
    }

    /** Null when the request is unknown, expired, not this device's, or unreachable. */
    fun fetchDispatch(deviceToken: String, dispatchId: String): Dispatch? {
        if (!DISPATCH_ID.matches(dispatchId)) return null
        return try {
            val (status, body) = request("GET", "/device/dispatch/$dispatchId", deviceToken, null)
            if (status != 200) return null
            val json = JSONObject(body)
            val variants: JSONArray = json.getJSONArray("queryVariants")
            Dispatch(List(variants.length()) { variants.getString(it) }, json.getLong("expiresAt"))
        } catch (_: Exception) {
            null
        }
    }

    /** `matched`: none | one | many. `outcome`: placed | cancelled | no_match. */
    fun report(deviceToken: String, dispatchId: String, matched: String, outcome: String): Boolean = try {
        val body = JSONObject().put("dispatchId", dispatchId).put("matched", matched).put("outcome", outcome)
        request("POST", "/device/report", deviceToken, body).first == 204
    } catch (_: IOException) {
        false
    }

    fun updatePushToken(deviceToken: String, pushToken: String): Boolean = try {
        request("POST", "/device/push-token", deviceToken, JSONObject().put("pushToken", pushToken)).first == 204
    } catch (_: IOException) {
        false
    }

    private fun request(method: String, path: String, bearer: String?, body: JSONObject?): Pair<Int, String> {
        val connection = URL(BuildConfig.SERVER_URL + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            bearer?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return status to text
        } finally {
            connection.disconnect()
        }
    }
}
