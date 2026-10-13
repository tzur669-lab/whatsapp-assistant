package com.tzur.callcompanion

/**
 * Speaking the answer to a voice note (0.16, block J, J6). Pure: the rules and
 * the at-most-once guard, tested on the JVM; [Speech] does the Android part.
 *
 * Spoken only when all hold: the setting is on (off by default), the reply is
 * the direct answer to an outgoing message of kind `voice` (never one that
 * arrives later by push), the ringer is normal (not silent or vibrate), and
 * this reply was never spoken before.
 */
object SpeechLogic {
    const val MAX_SPOKEN = 50

    fun shouldSpeak(enabled: Boolean, outgoingKind: String?, viaPush: Boolean, ringerNormal: Boolean, spoken: List<String>, replyId: String): Boolean =
        enabled && outgoingKind == "voice" && !viaPush && ringerNormal && replyId !in spoken

    /** The spoken list with one more id, the newest [MAX_SPOKEN] kept. */
    fun markSpoken(spoken: List<String>, replyId: String): List<String> =
        if (replyId in spoken) spoken else (spoken + replyId).takeLast(MAX_SPOKEN)

    /**
     * The one order (block J, J6), at most once: 1. the engine is ready,
     * 2. a Hebrew voice is there, 3. the id is persisted, 4. `speak()`. A
     * failure at 1 or 2 marks nothing and speaks nothing. A death between 3
     * and 4, or a `speak()` error, loses that one reading: speech is a
     * convenience, the reply is on screen.
     */
    enum class Step { NOT_READY, NO_HEBREW, SPEAK }

    fun step(engineReady: Boolean, hebrewAvailable: Boolean): Step = when {
        !engineReady -> Step.NOT_READY
        !hebrewAvailable -> Step.NO_HEBREW
        else -> Step.SPEAK
    }
}
