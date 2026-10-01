package com.tzur.callcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationLogicTest {
    @Test
    fun roundsToTwoDecimals() {
        val here = LocationLogic.coarse(32.08531, 34.78177)!!
        assertEquals(32.09, here.latitude, 0.0)
        assertEquals(34.78, here.longitude, 0.0)
    }

    @Test
    fun refusesWhatIsNotAPlace() {
        assertNull(LocationLogic.coarse(91.0, 0.0))
        assertNull(LocationLogic.coarse(0.0, -181.0))
        assertNull(LocationLogic.coarse(Double.NaN, 0.0))
    }

    @Test
    fun writesTheVoicePathSegmentTheServerMatches() {
        val server = Regex("^@-?[0-9]{1,2}\\.[0-9]{1,2},-?[0-9]{1,3}\\.[0-9]{1,2}$")
        for ((lat, lon) in listOf(32.08531 to 34.78177, -33.8688 to 151.2093, 0.0 to 0.0, -0.001 to -179.999, 90.0 to 180.0)) {
            val segment = LocationLogic.pathSegment(LocationLogic.coarse(lat, lon)!!)
            assertTrue(segment, server.matches(segment))
        }
        assertEquals("@32.09,34.78", LocationLogic.pathSegment(LocationLogic.coarse(32.08531, 34.78177)!!))
        assertEquals("@0.00,-180.00", LocationLogic.pathSegment(LocationLogic.coarse(-0.001, -179.999)!!))
    }

    @Test
    fun aFixIsFreshForFifteenMinutes() {
        val now = 1_000_000_000L
        assertTrue(LocationLogic.isFresh(now - 14 * 60_000L, now))
        assertFalse(LocationLogic.isFresh(now - 16 * 60_000L, now))
        assertFalse(LocationLogic.isFresh(now + 60_000L, now))
    }
}
