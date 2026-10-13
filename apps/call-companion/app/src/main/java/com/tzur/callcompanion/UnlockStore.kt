package com.tzur.callcompanion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.CharBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The PIN a scheduled routine may type on the lock screen (0.17, plan
 * `docs/plans/routine-auto-unlock.md`), and which routines may use it.
 *
 * The PIN is AES-GCM ciphertext under a Keystore key that needs no user
 * authentication — it must open while the phone is locked, which is the
 * whole point and the accepted risk. It never leaves this phone: private
 * preferences, excluded from backup and device transfer
 * (`data_extraction_rules.xml`); never logged, shown or sent.
 *
 * One attempt, ever: [beginAttempt] is written with `commit()` before the
 * first key, and a marker still there later — a wrong PIN, or the process
 * died mid-attempt — turns auto-unlock off until the PIN is saved again.
 */
object UnlockStore {
    private const val PREFS = "routine_unlock"
    private const val ALIAS = "routine_unlock_pin"
    private const val KEY_BLOB = "pin"
    private const val KEY_OPT_IN = "opt_in"
    private const val KEY_ATTEMPTING = "attempting"
    private const val KEY_FAILED = "failed"
    private const val GCM_TAG_BITS = 128

    fun hasPin(context: Context): Boolean = prefs(context).contains(KEY_BLOB)

    /** Auto-unlock turned itself off: a PIN that did not open, or an attempt that never finished. */
    fun failed(context: Context): Boolean {
        val p = prefs(context)
        return p.getBoolean(KEY_FAILED, false) || p.getBoolean(KEY_ATTEMPTING, false)
    }

    /** Saves [pin] (already checked by [UnlockLogic.pinProblem]) and clears a past failure. False if the Keystore refused. */
    fun savePin(context: Context, pin: CharArray): Boolean {
        val bytes = toBytes(pin)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
            val sealed = cipher.doFinal(bytes)
            val blob = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
            prefs(context).edit()
                .putString(KEY_BLOB, blob)
                .remove(KEY_ATTEMPTING)
                .remove(KEY_FAILED)
                .commit()
        } catch (_: Exception) {
            false
        } finally {
            bytes.fill(0)
        }
    }

    /**
     * The PIN, for one attempt; the caller zeroes it. Null when none is
     * stored, or it no longer opens (key or blob gone after a restore or a
     * cleared app): then everything is cleared, and the run asks as before.
     */
    fun readPin(context: Context): CharArray? {
        val blob = prefs(context).getString(KEY_BLOB, null) ?: return null
        var plain: ByteArray? = null
        return try {
            val (iv, sealed) = blob.split(':').let { Base64.decode(it[0], Base64.NO_WRAP) to Base64.decode(it[1], Base64.NO_WRAP) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(create = false) ?: throw IllegalStateException(), GCMParameterSpec(GCM_TAG_BITS, iv))
            plain = cipher.doFinal(sealed)
            CharArray(plain.size) { (plain[it].toInt() and 0xFF).toChar() }
                .takeIf { UnlockLogic.pinProblem(it) == null }
                ?: throw IllegalStateException()
        } catch (_: Exception) {
            clear(context)
            null
        } finally {
            plain?.fill(0)
        }
    }

    /** Removes the PIN, its key and every opt-in. */
    fun clear(context: Context) {
        prefs(context).edit().clear().commit()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (_: Exception) {
            // Nothing to delete, or the Keystore is unavailable: the blob is gone either way.
        }
    }

    /** Written before the first key is pressed, so a crash still counts as the one attempt. */
    fun beginAttempt(context: Context): Boolean = prefs(context).edit().putBoolean(KEY_ATTEMPTING, true).commit()

    /** The phone opened: the attempt is over. */
    fun attemptWorked(context: Context) {
        prefs(context).edit().remove(KEY_ATTEMPTING).commit()
    }

    /** The phone stayed locked: auto-unlock is off until the PIN is saved again. */
    fun attemptFailed(context: Context) {
        prefs(context).edit().remove(KEY_ATTEMPTING).putBoolean(KEY_FAILED, true).commit()
    }

    /** The step hash [routineId] was opted in with, or null. Editing the steps turns it off. */
    fun optedInHash(context: Context, routineId: String): String? =
        optIns(context).optString(routineId, "").ifEmpty { null }

    fun isOptedIn(context: Context, routine: RoutineLogic.Routine): Boolean =
        optedInHash(context, routine.id) == RoutineLogic.stepHash(routine)

    fun setOptIn(context: Context, routine: RoutineLogic.Routine, on: Boolean) {
        val map = optIns(context)
        if (on) map.put(routine.id, RoutineLogic.stepHash(routine)) else map.remove(routine.id)
        prefs(context).edit().putString(KEY_OPT_IN, map.toString()).commit()
    }

    /** A deleted routine takes its opt-in with it. */
    fun forget(context: Context, routineId: String) {
        val map = optIns(context)
        if (!map.has(routineId)) return
        map.remove(routineId)
        prefs(context).edit().putString(KEY_OPT_IN, map.toString()).commit()
    }

    private fun optIns(context: Context): JSONObject =
        try { JSONObject(prefs(context).getString(KEY_OPT_IN, "{}") ?: "{}") } catch (_: Exception) { JSONObject() }

    private fun toBytes(pin: CharArray): ByteArray {
        val buffer = Charsets.US_ASCII.encode(CharBuffer.wrap(pin))
        val out = ByteArray(buffer.remaining())
        buffer.get(out)
        if (buffer.hasArray()) java.util.Arrays.fill(buffer.array(), 0.toByte())
        return out
    }

    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
