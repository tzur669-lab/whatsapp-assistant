package com.tzur.callcompanion

import android.os.Build
import android.view.View
import android.view.WindowInsets

/** Small helpers shared by the screens, which are built in code: no layout files, no AndroidX. */
object Ui {
    /**
     * Android 15 draws every app edge to edge. Pad the root by the system bars
     * and the keyboard, so nothing hides under them and the input stays above
     * the keyboard. Older versions resize the window themselves.
     */
    fun fitSystemBars(root: View) {
        if (Build.VERSION.SDK_INT < 30) return
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
    }

    /** Latin, digits and times inside Hebrew keep their own order (FSI … PDI). */
    fun isolate(text: String): String = "$FSI$text$PDI"

    /**
     * The server wraps a URL inside Hebrew in isolates. Link detection takes the
     * closing one into the URL, and a tapped link then carries an invisible
     * character the server rejects. Strip them from around each URL.
     */
    fun cleanLinks(text: String): String = text.replace(URL_IN_ISOLATES) { it.groupValues[1] }

    private val URL_IN_ISOLATES = Regex("[\u2066-\u2068](https?://[^\\s\u2066-\u2069]+)\u2069")

    // Code points, not literals: see CallNotifier.ltr.
    private val FSI = Char(0x2068)
    private val PDI = Char(0x2069)
}
