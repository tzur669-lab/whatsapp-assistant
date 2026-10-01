package com.tzur.callcompanion

import android.os.Handler
import android.os.Looper

/**
 * How background work tells the open chat screen that something changed. One
 * listener at most — the chat screen while it is resumed.
 */
object ChatEvents {
    interface Listener {
        fun changed()
        fun unpaired()
    }

    private val main = Handler(Looper.getMainLooper())

    /** The chat is on screen: what arrives is seen there, so it is not also a notification. */
    @Volatile var foreground: Boolean = false

    @Volatile var listener: Listener? = null

    fun changed() {
        main.post { listener?.changed() }
    }

    fun unpaired() {
        main.post { listener?.unpaired() }
    }
}
