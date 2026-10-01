package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * The vectors below were produced by the server's own code
 * (`bot/src/channels/app/verify.ts`) — canonicalRequest, sha256Hex,
 * pairingMac, normalizePairingCode, and a signature Node made the way the
 * server's tests do. If the app drifts from the server, these fail.
 */
class ProtocolTest {
    private val body = Base64.getDecoder().decode(
        "eyJpZCI6IjBmOGZhZDViLWQ5Y2ItNDY5Zi1hMTY1LTcwODY3NzI4OTUwZSIsImtpbmQiOiJ0ZXh0IiwidGV4dCI6Iteq15bXm9eZ16gg15zXmSDXnteX16gg15EtOSJ9",
    )
    private val serverCanonical = listOf(
        "ASSISTANT-REQ-v1",
        "POST",
        "/app/message",
        "00112233445566778899aabbccddeeff",
        "1790000000000",
        "ffeeddccbbaa99887766554433221100",
        "dc7b9f94a4caf2558b0a9a4ad59bd06961fea1f9333cd175a243e6c1a942296c",
    ).joinToString("\n")
    private val serverKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEx8Tuh/haPyzw2XEt1uY8MrhrxW+KQtwdvYNzqFhm5gamLjLjfLalHdIH1gEJKPb18ppft9tu5hQYG2ougsMQtw=="
    private val serverSignature =
        "MEUCIQDD9hYqGx4EZ6P+xN13EEncxHGYrpMUdl4YWvJlvgadywIgPjCGaclBeW0YOgEmCF1+cVC38TNbXGjzOo4fMkM7ErA="

    private fun canonical(method: String = "post", body: ByteArray = this.body) = Protocol.canonical(
        method,
        "/app/message",
        "00112233445566778899aabbccddeeff",
        1_790_000_000_000L,
        "ffeeddccbbaa99887766554433221100",
        body,
    )

    @Test fun `the canonical string is the server's, byte for byte`() {
        assertEquals(serverCanonical, canonical())
    }

    @Test fun `an empty body hashes as the empty string`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Protocol.sha256Hex(ByteArray(0)))
    }

    @Test fun `a signature the server's side made verifies over the string the app builds`() {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(serverKey)))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(key)
        verifier.update(canonical().toByteArray(Charsets.UTF_8))
        assertTrue(verifier.verify(Base64.getDecoder().decode(serverSignature)))
    }

    @Test fun `one changed body byte breaks the signature`() {
        val tampered = body.copyOf().also { it[it.size - 2] = 'X'.code.toByte() }
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(serverKey)))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(key)
        verifier.update(canonical(body = tampered).toByteArray(Charsets.UTF_8))
        assertFalse(verifier.verify(Base64.getDecoder().decode(serverSignature)))
    }

    @Test fun `the JVM signs DER the server parses, with a key shaped like the Keystore's`() {
        val generator = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
        val pair = generator.generateKeyPair()
        // X.509 SubjectPublicKeyInfo of a P-256 key: 91 bytes, inside the server's 40..200 base64 bound.
        val spki = Base64.getEncoder().encodeToString(pair.public.encoded)
        assertEquals(124, spki.length)

        val signer = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private) }
        signer.update(canonical().toByteArray(Charsets.UTF_8))
        val der = signer.sign()
        // What the server's header check accepts: 8..96 base64 characters, a DER SEQUENCE.
        assertTrue(der.size in 8..72)
        assertEquals(0x30, der[0].toInt() and 0xff)
        assertEquals(der.size - 2, der[1].toInt() and 0xff)
    }

    @Test fun `the pairing MAC is the server's`() {
        assertEquals(
            "cf260fdadb96dd67e904313cd5e5f3294d6fcb345c6f368f2c4867e886b7f7db",
            Protocol.pairingMac("ABCDEFGHJKMNPQRSTV01", serverKey, "fake-fcm-token", 1_790_000_000_000L),
        )
    }

    @Test fun `codes normalise the way the server does`() {
        assertEquals("00111110000000000000", Protocol.normalizePairingCode("oO1-iIlL-0000-0000-00000"))
        assertEquals("ABCDEFGHJKMNPQRSTV01", Protocol.normalizePairingCode(" abcd efgh jkmn pqrs tv01 "))
        assertNull(Protocol.normalizePairingCode("ABCD-EFGH-JKMN-PQRS-TVU1")) // U is not Crockford
        assertNull(Protocol.normalizePairingCode("short"))
    }

    @Test fun `nonces and message ids have the shapes the server requires`() {
        val nonce = Protocol.newNonce()
        assertTrue(Regex("^[0-9a-f]{32}$").matches(nonce))
        assertFalse(nonce == Protocol.newNonce())
        assertTrue(Protocol.MESSAGE_ID.matches(Protocol.newMessageId()))
    }

    @Test fun `only server-shaped button ids pass`() {
        assertTrue(Protocol.BUTTON_ID.matches("snooze:0a1b2c:9f8e7d:m10"))
        assertFalse(Protocol.BUTTON_ID.matches("Snooze"))
        assertFalse(Protocol.BUTTON_ID.matches(""))
        assertFalse(Protocol.BUTTON_ID.matches("a b"))
    }
}
