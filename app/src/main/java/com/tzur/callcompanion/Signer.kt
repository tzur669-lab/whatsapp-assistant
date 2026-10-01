package com.tzur.callcompanion

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * This phone's identity toward the server (PLAN §6.18): a P-256 key made in
 * the Android Keystore that can sign but never be exported, and the device id
 * the server gave its public half.
 *
 * Nothing here is a bearer secret. The device id is public; the private key
 * never leaves the Keystore. Someone who reads a request on the way — the home
 * network intercepts TLS — learns nothing that lets them sign another.
 *
 * Pairing makes a *pending* key and keeps it until a pairing succeeds, so a
 * retry after a lost answer presents the same key (the server answers that
 * with the same device), and a failed attempt never destroys the working key.
 */
// commit(), not apply(): the identity must be on disk before an old key is
// deleted, or a crash in between leaves a device id with no key behind it.
@SuppressLint("ApplySharedPref")
class Signer(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("identity", Context.MODE_PRIVATE)

    val deviceId: String? get() = prefs.getString(KEY_DEVICE, null)?.takeIf { Protocol.DEVICE_ID.matches(it) }

    val isPaired: Boolean get() = deviceId != null && activeKey() != null

    /** The public half of the key the next pairing will present, as base64 SPKI. */
    fun pendingPublicKey(): String {
        val alias = prefs.getString(KEY_PENDING, null) ?: newAlias().also {
            prefs.edit().putString(KEY_PENDING, it).commit()
        }
        if (!keyStore().containsAlias(alias)) generate(alias)
        val encoded = keyStore().getCertificate(alias).publicKey.encoded
        return Base64.getEncoder().encodeToString(encoded)
    }

    /** The server accepted the pending key. It becomes the one that signs; the old one is deleted. */
    fun completePairing(newDeviceId: String) {
        require(Protocol.DEVICE_ID.matches(newDeviceId))
        val pending = prefs.getString(KEY_PENDING, null) ?: error("no pending key")
        val previous = prefs.getString(KEY_ACTIVE, null)
        prefs.edit()
            .putString(KEY_ACTIVE, pending)
            .putString(KEY_DEVICE, newDeviceId)
            .remove(KEY_PENDING)
            .commit()
        if (previous != null && previous != pending) deleteKey(previous)
    }

    /** The server no longer knows this phone (`unpaired`). Pairing again starts from a new key. */
    fun forget() {
        val active = prefs.getString(KEY_ACTIVE, null)
        prefs.edit().remove(KEY_ACTIVE).remove(KEY_DEVICE).commit()
        if (active != null) deleteKey(active)
    }

    /** DER, as the server expects it. Null when there is no key to sign with. */
    fun sign(canonical: String): ByteArray? {
        val key = activeKey() ?: return null
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(canonical.toByteArray(Charsets.UTF_8))
            sign()
        }
    }

    /** Version 0.1 kept a bearer token in `vault`. The server no longer accepts one; it goes. */
    fun dropLegacyToken(context: Context) {
        context.getSharedPreferences("vault", Context.MODE_PRIVATE).edit().clear().commit()
        deleteKey("device_token_key")
    }

    private fun activeKey(): PrivateKey? {
        val alias = prefs.getString(KEY_ACTIVE, null) ?: return null
        return try {
            keyStore().getKey(alias, null) as? PrivateKey
        } catch (_: Exception) {
            null
        }
    }

    private fun generate(alias: String) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    private fun deleteKey(alias: String) {
        try {
            keyStore().deleteEntry(alias)
        } catch (_: Exception) {
            // Already gone. Nothing signs with it either way.
        }
    }

    private fun newAlias(): String = "device_key_" + Protocol.newNonce()

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ACTIVE = "active_alias"
        const val KEY_PENDING = "pending_alias"
        const val KEY_DEVICE = "device_id"
    }
}
