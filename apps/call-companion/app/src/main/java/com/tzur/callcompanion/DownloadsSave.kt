package com.tzur.callcompanion

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore

/**
 * Writes a file to the public Downloads folder through MediaStore, which needs
 * no permission on Android 10 and later (as the expenses CSV in
 * [DeviceActions]). Earlier versions are refused rather than asked for storage.
 */
object DownloadsSave {
    /** True when the file was written. */
    fun save(context: Context, name: String, mime: String, bytes: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("no stream")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } catch (_: Exception) {
            resolver.delete(uri, null, null)
            false
        }
    }
}
