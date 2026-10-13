package com.tzur.callcompanion

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Speaks the answer to a voice note (0.16, block J, J6), in `he-IL`, with the
 * phone's own `TextToSpeech`. Nothing leaves the phone.
 *
 * Everything here runs on the main thread: the check, the mark and the call
 * to `speak()` cannot interleave. The engine is created when first needed and
 * shut down when the chat screen goes ([shutdown]). The order is
 * [SpeechLogic.step]'s; the id is committed before `speak()`, so a reply is
 * spoken at most once whatever happens to the process.
 */
object Speech {
    private const val PREFS = "speech"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_SPOKEN = "spoken"
    private const val KEY_NO_HEBREW = "no_hebrew"
    private val HEBREW = Locale("he", "IL")

    private val main = Handler(Looper.getMainLooper())
    private var engine: TextToSpeech? = null
    private var ready = false
    private var waiting: Pair<String, String>? = null

    fun enabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, on).apply()
    }

    /** The last try found no Hebrew voice: the settings screen says so. */
    fun noHebrew(context: Context) = prefs(context).getBoolean(KEY_NO_HEBREW, false)

    /**
     * A reply arrived as the direct answer to message [outgoingId] (never a
     * push). Spoken if [SpeechLogic.shouldSpeak] says so.
     */
    fun onReply(context: Context, outgoingId: String, replyId: String, text: String) {
        val app = context.applicationContext
        main.post {
            val kind = ChatStore.get(app).kindOfMessage(outgoingId)
            val audio = app.getSystemService(AudioManager::class.java)
            val ringerNormal = audio?.ringerMode == AudioManager.RINGER_MODE_NORMAL
            if (!SpeechLogic.shouldSpeak(enabled(app), kind, viaPush = false, ringerNormal, spoken(app), replyId)) return@post
            waiting = replyId to text
            val current = engine
            if (current == null) {
                engine = TextToSpeech(app) { status ->
                    ready = status == TextToSpeech.SUCCESS
                    sayWaiting(app)
                }
            } else {
                sayWaiting(app)
            }
        }
    }

    private fun sayWaiting(app: Context) {
        val (replyId, text) = waiting ?: return
        val tts = engine ?: return
        val hebrew = ready && tts.isLanguageAvailable(HEBREW) >= TextToSpeech.LANG_AVAILABLE
        when (SpeechLogic.step(ready, hebrew)) {
            SpeechLogic.Step.NOT_READY -> waiting = null
            SpeechLogic.Step.NO_HEBREW -> {
                waiting = null
                prefs(app).edit().putBoolean(KEY_NO_HEBREW, true).apply()
            }
            SpeechLogic.Step.SPEAK -> {
                waiting = null
                tts.language = HEBREW
                // Persisted first: a process that dies before speak() loses this one reading, never repeats it.
                val marked = SpeechLogic.markSpoken(spoken(app), replyId)
                prefs(app).edit().putString(KEY_SPOKEN, marked.joinToString(",")).putBoolean(KEY_NO_HEBREW, false).commit()
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, replyId)
            }
        }
    }

    /** A tap on the chat stops the reading. */
    fun stop() {
        main.post { engine?.stop() }
    }

    /** The chat screen is gone: the engine goes with it. */
    fun shutdown() {
        main.post {
            engine?.shutdown()
            engine = null
            ready = false
            waiting = null
        }
    }

    private fun spoken(context: Context): List<String> =
        prefs(context).getString(KEY_SPOKEN, null)?.split(',')?.filter { it.isNotEmpty() } ?: emptyList()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
