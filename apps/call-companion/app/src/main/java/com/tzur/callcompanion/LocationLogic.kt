package com.tzur.callcompanion

import java.util.Locale

/**
 * The location's rules that need no Android (0.8): how coarse it is, how old a
 * fix may be, and how it is written on the wire. Two decimals, about a
 * kilometre: enough for the weather and the Shabbat times, not an address.
 */
object LocationLogic {
    /** A fix older than this is not "where I am now". */
    const val MAX_AGE_MS = 15 * 60_000L
    /** How long a message may wait for a fresh fix before it goes without one. */
    const val FIX_TIMEOUT_MS = 4_000L

    class Coarse(val latitude: Double, val longitude: Double)

    /** Null for anything that is not a place on Earth. */
    fun coarse(latitude: Double, longitude: Double): Coarse? {
        if (latitude.isNaN() || longitude.isNaN()) return null
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
        return Coarse(round2(latitude), round2(longitude))
    }

    fun isFresh(fixAtMs: Long, nowMs: Long): Boolean = nowMs - fixAtMs in 0..MAX_AGE_MS

    /** A voice note's path segment, which the server matches exactly: `@32.09,34.78`. */
    fun pathSegment(location: Coarse): String =
        "@${fixed(location.latitude)},${fixed(location.longitude)}"

    private fun round2(value: Double): Double = Math.round(value * 100.0) / 100.0

    private fun fixed(value: Double): String {
        val text = String.format(Locale.ROOT, "%.2f", value)
        // "-0.00" is still zero; the server would take it, but there is no reason to send the sign.
        return if (text == "-0.00") "0.00" else text
    }
}
