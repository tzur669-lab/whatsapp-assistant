package com.tzur.callcompanion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Where the phone is, when a message is sent (0.8, PLAN §14 2026-10-01): for
 * the weather and the Shabbat times only. Coarse — the permission asked for is
 * the approximate one, and [LocationLogic] rounds again — and only while the
 * user keeps it on in the menu. Read on the sending thread, never stored.
 */
object PhoneLocation {
    private const val PREFS = "location"
    private const val PREF_ON = "on"
    private const val PREF_ASKED = "asked"

    private val executor = Executors.newSingleThreadExecutor()

    fun isOn(context: Context): Boolean = prefs(context).getBoolean(PREF_ON, true)

    fun setOn(context: Context, on: Boolean) = prefs(context).edit().putBoolean(PREF_ON, on).apply()

    fun granted(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** True once: the chat asks for the permission the first time it opens. */
    fun shouldAsk(context: Context): Boolean {
        val prefs = prefs(context)
        if (prefs.getBoolean(PREF_ASKED, false) || granted(context)) return false
        prefs.edit().putBoolean(PREF_ASKED, true).apply()
        return true
    }

    /**
     * A fresh fix, or a recent one, or null — never a wait longer than
     * [LocationLogic.FIX_TIMEOUT_MS]. Blocks: call it off the main thread.
     */
    fun now(context: Context): LocationLogic.Coarse? {
        if (!isOn(context) || !granted(context)) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        return try {
            (current(manager) ?: lastKnown(manager))?.let { LocationLogic.coarse(it.latitude, it.longitude) }
        } catch (_: SecurityException) {
            null // revoked between the check and the read
        } catch (_: IllegalArgumentException) {
            null // no such provider on this phone
        }
    }

    // Both below run only from [now], after its permission check.
    @SuppressLint("MissingPermission")
    private fun current(manager: LocationManager): Location? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        if (!manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return null
        val latch = CountDownLatch(1)
        val cancel = CancellationSignal()
        var fix: Location? = null
        manager.getCurrentLocation(LocationManager.NETWORK_PROVIDER, cancel, executor) { location ->
            fix = location
            latch.countDown()
        }
        if (!latch.await(LocationLogic.FIX_TIMEOUT_MS, TimeUnit.MILLISECONDS)) cancel.cancel()
        return fix
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown(manager: LocationManager): Location? {
        val now = System.currentTimeMillis()
        return listOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, LocationManager.GPS_PROVIDER)
            .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
            .filter { LocationLogic.isFresh(it.time, now) }
            .maxByOrNull { it.time }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
