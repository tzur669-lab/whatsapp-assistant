package com.tzur.callcompanion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageLogicTest {
    @Test fun `a large picture is shrunk to the long edge and keeps its aspect`() {
        assertEquals(1600 to 1200, ImageLogic.targetSize(4000, 3000))
        assertEquals(1200 to 1600, ImageLogic.targetSize(3000, 4000))
        assertEquals(1600 to 900, ImageLogic.targetSize(3840, 2160))
    }

    @Test fun `a small picture is never made larger`() {
        assertEquals(800 to 600, ImageLogic.targetSize(800, 600))
        assertEquals(1600 to 1600, ImageLogic.targetSize(1600, 1600))
    }

    @Test fun `a very thin picture keeps at least one pixel`() {
        assertEquals(1600 to 1, ImageLogic.targetSize(100_000, 10))
        assertEquals(1 to 1600, ImageLogic.targetSize(10, 100_000))
    }

    @Test fun `the target edge can be chosen`() {
        assertEquals(500 to 250, ImageLogic.targetSize(2000, 1000, maxEdge = 500))
    }

    @Test fun `the decoder samples by the largest power of two that stays at or above the target`() {
        assertEquals(1, ImageLogic.sampleSize(1600, 1200))
        assertEquals(1, ImageLogic.sampleSize(2000, 1500)) // 1000 would fall under 1600
        assertEquals(2, ImageLogic.sampleSize(4000, 3000)) // 2000 x 1500 still covers 1600 x 1200
        assertEquals(4, ImageLogic.sampleSize(8000, 6000)) // 2000 x 1500
        assertEquals(8, ImageLogic.sampleSize(12_800, 9_600)) // 1600 x 1200
    }

    @Test fun `sampling never goes under either side of the target`() {
        for ((w, h) in listOf(4000 to 3000, 3000 to 4000, 9000 to 700, 700 to 9000, 5000 to 5000)) {
            val sample = ImageLogic.sampleSize(w, h)
            val (tw, th) = ImageLogic.targetSize(w, h)
            assertTrue(w / sample >= tw && h / sample >= th)
            // and one more halving would have
            assertTrue(w / (sample * 2) < tw || h / (sample * 2) < th)
        }
    }

    @Test fun `qualities run from best to lowest`() {
        assertEquals(listOf(85, 75, 65, 55, 45, 40), ImageLogic.QUALITIES)
    }

    @Test fun `the first quality that fits wins and later ones are not tried`() {
        val tried = mutableListOf<Int>()
        val picked = ImageLogic.pick { quality ->
            tried += quality
            ByteArray(if (quality > 65) Protocol.MAX_IMAGE_BYTES + 1 else Protocol.MAX_IMAGE_BYTES)
        }
        assertEquals(listOf(85, 75, 65), tried)
        assertEquals(Protocol.MAX_IMAGE_BYTES, picked?.size)
    }

    @Test fun `the best quality is kept when it already fits`() {
        val bytes = byteArrayOf(1, 2, 3)
        assertArrayEquals(bytes, ImageLogic.pick { bytes })
    }

    @Test fun `no quality fitting gives nothing`() {
        val tried = mutableListOf<Int>()
        assertNull(ImageLogic.pick { quality -> tried += quality; ByteArray(Protocol.MAX_IMAGE_BYTES + 1) })
        assertEquals(ImageLogic.QUALITIES, tried)
    }

    @Test fun `exif orientation turns into clockwise degrees`() {
        assertEquals(90, ImageLogic.rotationDegrees(6))
        assertEquals(180, ImageLogic.rotationDegrees(3))
        assertEquals(270, ImageLogic.rotationDegrees(8))
        assertEquals(0, ImageLogic.rotationDegrees(1))
        assertEquals(0, ImageLogic.rotationDegrees(0))
        assertEquals(0, ImageLogic.rotationDegrees(2)) // mirrored: left as it is
    }
}
