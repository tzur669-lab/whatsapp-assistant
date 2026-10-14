package com.tzur.callcompanion

/**
 * The rules for a picture sent to the assistant (0.19) that need no Android:
 * how far it is shrunk, how it is decoded cheaply, and how hard it is
 * compressed to fit the server's cap. Pure Kotlin, so they are tested on the
 * JVM; [ImagePrep] does the decoding.
 */
object ImageLogic {
    /** The long edge, in pixels: enough to read a receipt or an invitation. */
    const val MAX_EDGE = 1_600

    /** JPEG qualities tried in order; the first that fits [Protocol.MAX_IMAGE_BYTES] wins. */
    val QUALITIES = listOf(85, 75, 65, 55, 45, 40)

    /** The size to scale to: the aspect kept, never larger than the picture, never below one pixel. */
    fun targetSize(width: Int, height: Int, maxEdge: Int = MAX_EDGE): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (width <= 0 || height <= 0 || longest <= maxEdge) return maxOf(width, 1) to maxOf(height, 1)
        val scale = maxEdge.toDouble() / longest
        return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
    }

    /** `inSampleSize` for the decoder: the largest power of two that leaves both sides at least the target's. */
    fun sampleSize(width: Int, height: Int, maxEdge: Int = MAX_EDGE): Int {
        val (targetWidth, targetHeight) = targetSize(width, height, maxEdge)
        var sample = 1
        while (width / (sample * 2) >= targetWidth && height / (sample * 2) >= targetHeight) sample *= 2
        return sample
    }

    /** The first encoding within the server's cap, tried from the best quality down; null when none fits. */
    fun pick(encode: (Int) -> ByteArray): ByteArray? {
        for (quality in QUALITIES) {
            val bytes = encode(quality)
            if (bytes.size <= Protocol.MAX_IMAGE_BYTES) return bytes
        }
        return null
    }

    /** Clockwise degrees to turn a picture upright, from its EXIF orientation. A mirrored one is left as it is. */
    fun rotationDegrees(exifOrientation: Int): Int = when (exifOrientation) {
        6 -> 90
        3 -> 180
        8 -> 270
        else -> 0
    }
}
