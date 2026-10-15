package com.tzur.callcompanion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.ByteArrayOutputStream

/**
 * A picture the user chose, made ready to send (0.19): decoded at a reduced
 * size, turned upright, and encoded as a JPEG that fits [Protocol.MAX_IMAGE_BYTES].
 * Encoding again drops the EXIF block, so the place a photo was taken never
 * leaves the phone. Only the result is kept in memory; nothing is written.
 *
 * Blocking, and heavy on memory: run it off the main thread.
 */
object ImagePrep {
    sealed class Outcome {
        class Ready(val jpeg: ByteArray) : Outcome()
        /** Even the lowest quality is over the server's cap. */
        object TooLarge : Outcome()
        /** Not a picture, unreadable, or the phone ran out of memory. */
        object Failed : Outcome()
    }

    fun prepare(context: Context, uri: Uri): Outcome = try {
        encode(context, uri)
    } catch (_: Exception) {
        Outcome.Failed
    } catch (_: OutOfMemoryError) {
        Outcome.Failed
    }

    private fun encode(context: Context, uri: Uri): Outcome {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        // A bounds-only decode always returns null: only the stream itself says the picture could not be opened.
        val stream = resolver.openInputStream(uri) ?: return Outcome.Failed
        stream.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return Outcome.Failed

        val options = BitmapFactory.Options().apply {
            inSampleSize = ImageLogic.sampleSize(bounds.outWidth, bounds.outHeight)
        }
        val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return Outcome.Failed

        var current = decoded
        try {
            val (width, height) = ImageLogic.targetSize(bounds.outWidth, bounds.outHeight)
            if (current.width != width || current.height != height) {
                // The target is for the upright picture's unrotated size; scaling here keeps the aspect.
                val scaled = Bitmap.createScaledBitmap(current, width, height, true)
                if (scaled !== current) current.recycle()
                current = scaled
            }
            val degrees = ImageLogic.rotationDegrees(orientationOf(context, uri))
            if (degrees != 0) {
                val turned = Bitmap.createBitmap(current, 0, 0, current.width, current.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
                if (turned !== current) current.recycle()
                current = turned
            }
            val finished = current
            val jpeg = ImageLogic.pick { quality ->
                ByteArrayOutputStream().also { finished.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
            }
            return if (jpeg == null) Outcome.TooLarge else Outcome.Ready(jpeg)
        } finally {
            current.recycle()
        }
    }

    /** The EXIF orientation tag, or "normal" when the picture has none or it cannot be read. */
    private fun orientationOf(context: Context, uri: Uri): Int = try {
        context.contentResolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } ?: ExifInterface.ORIENTATION_NORMAL
    } catch (_: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }
}
