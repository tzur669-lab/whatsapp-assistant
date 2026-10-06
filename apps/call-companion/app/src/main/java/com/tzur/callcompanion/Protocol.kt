package com.tzur.callcompanion

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The wire format shared with the server (`bot/src/channels/app/verify.ts`,
 * PLAN §6.18). Plain JVM, no Android classes, so the unit tests can pin it
 * against vectors produced by the server's own code.
 *
 * Every request after pairing is signed over one canonical string:
 *
 *     ASSISTANT-REQ-v1 \n METHOD \n path \n deviceId \n timestamp \n nonce \n hex(sha256(raw body))
 *
 * The body enters only as the hash of the exact bytes sent, so whatever
 * writes the body must hand the same array to [canonical] and to the socket.
 */
object Protocol {
    const val SIGNATURE_VERSION = "ASSISTANT-REQ-v1"
    const val PAIR_VERSION = "ASSISTANT-PAIR-v1"

    /** What a server button id may look like (`confirm/pending.ts`); anything else is not sent. */
    val BUTTON_ID = Regex("^[a-z0-9:]{1,256}$")
    val DEVICE_ID = Regex("^[0-9a-f]{32}$")
    val MESSAGE_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    /** The server's inbound cap on a typed message. */
    const val MAX_TEXT_CHARS = 2_000
    /** The server's cap on text shared from another app (`parse.ts`, 2026-10-06). */
    const val MAX_SHARED_CHARS = 1_200

    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val CODE_LENGTH = 20
    private val random = SecureRandom()

    fun canonical(method: String, path: String, deviceId: String, timestamp: Long, nonce: String, body: ByteArray): String =
        listOf(SIGNATURE_VERSION, method.uppercase(), path, deviceId, timestamp.toString(), nonce, sha256Hex(body))
            .joinToString("\n")

    fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** 128 random bits, lowercase hex: a fresh one for every request, retries included. */
    fun newNonce(): String = ByteArray(16).also(random::nextBytes).let(::hex)

    /** A client message id. A retry of the same message reuses it; that is the server's dedupe key. */
    fun newMessageId(): String = UUID.randomUUID().toString().lowercase()

    /**
     * What the user typed, as the canonical code, or null. The same rules as
     * the server's `normalizePairingCode`: case, spaces and dashes do not
     * matter, and O / I / L read as 0 / 1 / 1.
     */
    fun normalizePairingCode(input: String): String? {
        val cleaned = input.uppercase()
            .replace(Regex("[\\s-]"), "")
            .replace('O', '0')
            .replace('I', '1')
            .replace('L', '1')
        return if (cleaned.length == CODE_LENGTH && cleaned.all { it in CROCKFORD }) cleaned else null
    }

    /**
     * The proof that this phone knows the code, without sending it: an HMAC
     * keyed by the code over this phone's own public key and push address, so
     * whoever reads it on the way cannot attach a key of their own.
     */
    fun pairingMac(code: String, publicKey: String, pushToken: String, timestamp: Long): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(code.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val message = listOf(PAIR_VERSION, publicKey, pushToken, timestamp.toString()).joinToString("\n")
        return hex(mac.doFinal(message.toByteArray(Charsets.UTF_8)))
    }

    private fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append("0123456789abcdef"[v ushr 4]).append("0123456789abcdef"[v and 0x0f])
        }
        return out.toString()
    }
}
