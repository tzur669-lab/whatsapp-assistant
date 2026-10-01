package com.tzur.callcompanion

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.File

/**
 * Hold to record, release to send (PLAN §6.18). AAC in MP4, mono, 16 kHz at
 * 32 kbit/s — what Whisper needs and about 240 KB a minute, well under the
 * server's 1 MB cap. Sixty seconds at most.
 *
 * The file lives in `noBackupFilesDir` only while recording. [stop] reads it
 * into memory and deletes it in `finally`; [cleanUp] removes anything a crash
 * left behind. Nothing recorded is kept on the phone.
 */
class VoiceRecorder(private val context: Context) {
    class Recording(val audio: ByteArray, val durationMs: Long)

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val isRecording: Boolean get() = recorder != null

    /** False when the microphone could not be opened. */
    fun start(onMaxDuration: () -> Unit): Boolean {
        if (recorder != null) return true
        val target = File(dir(context), "${Protocol.newNonce()}.m4a")
        val created = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            created.setAudioSource(MediaRecorder.AudioSource.MIC)
            created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            created.setAudioChannels(1)
            created.setAudioSamplingRate(16_000)
            created.setAudioEncodingBitRate(32_000)
            created.setMaxDuration(MAX_MS)
            created.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onMaxDuration()
            }
            created.setOutputFile(target.absolutePath)
            created.prepare()
            created.start()
            recorder = created
            file = target
            startedAt = SystemClock.elapsedRealtime()
            true
        } catch (_: Exception) {
            created.release()
            target.delete()
            false
        }
    }

    /** The recording, or null when it was too short, failed, or too large to send. */
    fun stop(): Recording? {
        val active = recorder ?: return null
        val target = file
        val duration = SystemClock.elapsedRealtime() - startedAt
        recorder = null
        file = null
        try {
            // stop() throws when almost nothing was recorded.
            active.stop()
            if (target == null || duration < MIN_MS) return null
            val bytes = target.readBytes()
            return if (bytes.isEmpty() || bytes.size > MAX_BYTES) null else Recording(bytes, duration)
        } catch (_: Exception) {
            return null
        } finally {
            active.release()
            target?.delete()
        }
    }

    fun cancel() {
        val active = recorder ?: return
        recorder = null
        try {
            active.stop()
        } catch (_: Exception) {
            // Nothing worth keeping either way.
        } finally {
            active.release()
            file?.delete()
            file = null
        }
    }

    companion object {
        private const val MAX_MS = 60_000
        private const val MIN_MS = 700L
        /** The server's cap (`MAX_VOICE_BYTES`). */
        private const val MAX_BYTES = 1024 * 1024

        private fun dir(context: Context): File = File(context.noBackupFilesDir, "voice").apply { mkdirs() }

        /** Whatever a crash left behind. */
        fun cleanUp(context: Context) {
            dir(context).listFiles()?.forEach { it.delete() }
        }
    }
}
