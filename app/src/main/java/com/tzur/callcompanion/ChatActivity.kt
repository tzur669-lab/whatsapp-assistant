package com.tzur.callcompanion

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.text.method.LinkMovementMethod
import android.text.util.Linkify
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * The assistant, as a chat (PLAN §6.18). Typed text, a held microphone, and
 * the buttons under the assistant's messages all become one message each,
 * sent by [Turns] one at a time. While one is out, sending is locked.
 */
class ChatActivity : Activity(), ChatEvents.Listener {
    private lateinit var store: ChatStore
    private lateinit var recorder: VoiceRecorder
    private lateinit var list: ListView
    private lateinit var empty: TextView
    private lateinit var banner: TextView
    private lateinit var status: TextView
    private lateinit var input: EditText
    private lateinit var sendButton: Button
    private lateinit var micButton: Button
    private val adapter = MessagesAdapter()
    private var messages: List<ChatStore.Message> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Before the pairing check: an install upgraded from 0.1 is never paired.
        Signer(this).dropLegacyToken(this)
        if (!Signer(this).isPaired) return toPairing(unpairedByServer = false)

        store = ChatStore.get(this)
        recorder = VoiceRecorder(this)
        if (!Turns.busy) {
            store.failStale()
            VoiceRecorder.cleanUp(this)
        }
        Notifier.ensureChannels(this)
        CallNotifier.ensureChannel(this)

        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
    }

    override fun onResume() {
        super.onResume()
        if (!Signer(this).isPaired) return toPairing(unpairedByServer = false)
        ChatEvents.foreground = true
        ChatEvents.listener = this
        Notifier.cancelAll(this)
        refresh()

        val app = applicationContext
        Thread { Sync.run(app, Api.SHORT_TIMEOUT_MS) }.start()
        PushToken.refreshIfDue(this)
    }

    override fun onPause() {
        super.onPause()
        ChatEvents.foreground = false
        if (ChatEvents.listener === this) ChatEvents.listener = null
        if (::recorder.isInitialized && recorder.isRecording) recorder.cancel()
    }

    override fun changed() = refresh()

    override fun unpaired() = toPairing(unpairedByServer = true)

    // -- layout -----------------------------------------------------------------

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    // The microphone is hold-to-talk: press and release are the gesture, and
    // release calls performClick for accessibility services.
    @SuppressLint("ClickableViewAccessibility")
    private fun buildLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(8), dp(8))
            setBackgroundColor(HEADER)
        }
        header.addView(TextView(this).apply {
            text = getString(R.string.chat_title)
            textSize = 20f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(Button(this).apply {
            text = getString(R.string.chat_settings)
            isAllCaps = false
            setOnClickListener { startActivity(Intent(this@ChatActivity, PairActivity::class.java)) }
        })
        root.addView(header)

        banner = TextView(this).apply {
            text = getString(R.string.chat_notifications_off)
            setBackgroundColor(BANNER)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            visibility = View.GONE
            setOnClickListener {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
                )
            }
        }
        root.addView(banner)

        val frame = FrameLayout(this)
        list = ListView(this).apply {
            divider = null
            transcriptMode = ListView.TRANSCRIPT_MODE_ALWAYS_SCROLL
            isStackFromBottom = true
            // Rows are not tappable; only the buttons inside them are.
            selector = ColorDrawable(Color.TRANSPARENT)
            adapter = this@ChatActivity.adapter
        }
        empty = TextView(this).apply {
            text = getString(R.string.chat_empty)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        frame.addView(list)
        frame.addView(empty)
        root.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        status = TextView(this).apply {
            setPadding(dp(16), dp(4), dp(16), dp(4))
            textSize = 13f
            visibility = View.GONE
        }
        root.addView(status)

        // In RTL the first child sits on the right: the field, then send, then the microphone.
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
            setPadding(dp(8), dp(4), dp(8), dp(8))
        }
        input = EditText(this).apply {
            hint = getString(R.string.chat_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 5
            textDirection = View.TEXT_DIRECTION_FIRST_STRONG_RTL
            filters = arrayOf(InputFilter.LengthFilter(Protocol.MAX_TEXT_CHARS))
        }
        inputRow.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        sendButton = Button(this).apply {
            text = getString(R.string.chat_send)
            isAllCaps = false
            setOnClickListener { sendTyped() }
        }
        inputRow.addView(sendButton)
        micButton = Button(this).apply {
            text = getString(R.string.chat_mic)
            contentDescription = getString(R.string.chat_mic_description)
            setOnTouchListener { view, event -> onMicTouch(view, event) }
        }
        inputRow.addView(micButton)
        root.addView(inputRow)

        Ui.fitSystemBars(root)
        return root
    }

    // -- sending ----------------------------------------------------------------

    private fun sendTyped() {
        val text = input.text.toString().trim()
        if (text.isEmpty() || Turns.busy) return
        Turns.sendText(this, text)
        input.text.clear()
        refresh()
    }

    private fun onMicTouch(view: View, event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> startRecording()
            MotionEvent.ACTION_UP -> {
                finishRecording()
                view.performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                recorder.cancel()
                refresh()
            }
        }
        return true
    }

    private fun startRecording() {
        if (Turns.busy) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
            return
        }
        // Sixty seconds: the recorder stops itself and the recording is sent as if released.
        if (!recorder.start { runOnUiThread { finishRecording() } }) {
            Toast.makeText(this, R.string.chat_mic_failed, Toast.LENGTH_LONG).show()
        }
        refresh()
    }

    private fun finishRecording() {
        if (!recorder.isRecording) return
        val recording = recorder.stop()
        if (recording == null) {
            Toast.makeText(this, R.string.chat_too_short, Toast.LENGTH_SHORT).show()
        } else {
            val seconds = recording.durationMs / 1000
            val length = Ui.isolate("%d:%02d".format(Locale.ROOT, seconds / 60, seconds % 60))
            Turns.sendVoice(this, recording.audio, getString(R.string.chat_voice_label, length))
        }
        refresh()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MIC) return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        Toast.makeText(this, if (granted) R.string.chat_mic_ready else R.string.chat_mic_permission, Toast.LENGTH_LONG).show()
    }

    // -- state ------------------------------------------------------------------

    private fun refresh() {
        if (!::store.isInitialized) return
        messages = store.all()
        adapter.notifyDataSetChanged()
        empty.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE

        val busy = Turns.busy
        sendButton.isEnabled = !busy
        micButton.isEnabled = !busy || recorder.isRecording
        status.visibility = if (busy || recorder.isRecording) View.VISIBLE else View.GONE
        status.text = getString(if (recorder.isRecording) R.string.chat_recording else R.string.chat_busy)
        banner.visibility = if (Notifier.areEnabled(this)) View.GONE else View.VISIBLE

        // A card the server allows to run alone does, while the chat is on screen
        // and the card is fresh (PLAN §6.20). `takeCard` makes this once-only.
        if (ChatEvents.foreground) {
            for (message in messages) {
                val seq = message.seq ?: continue
                val card = message.card ?: continue
                if (Cards.shouldAutoRun(message)) Cards.run(this, seq, card)
            }
        }
    }

    private fun toPairing(unpairedByServer: Boolean) {
        startActivity(
            Intent(this, PairActivity::class.java)
                .putExtra(PairActivity.EXTRA_UNPAIRED, unpairedByServer)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
        finish()
    }

    // -- the list -----------------------------------------------------------------

    private inner class MessagesAdapter : BaseAdapter() {
        override fun getCount(): Int = messages.size
        override fun getItem(position: Int): Any = messages[position]
        override fun getItemId(position: Int): Long = messages[position].localId
        override fun hasStableIds(): Boolean = true

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = bubble(messages[position])
    }

    private fun bubble(message: ChatStore.Message): View {
        val side = if (message.outgoing) Gravity.END else Gravity.START
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = side
            setPadding(dp(8), dp(3), dp(8), dp(3))
        }

        val color = when {
            message.outgoing -> OUTGOING
            message.kind == "reminder" -> REMINDER
            message.seq == null -> NOTICE
            else -> INCOMING
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(color)
            }
            setPadding(dp(12), dp(8), dp(12), dp(6))
        }

        box.addView(TextView(this).apply {
            // `/connect google` answers with a link; it has to open. Set before the text.
            autoLinkMask = Linkify.WEB_URLS
            movementMethod = LinkMovementMethod.getInstance()
            text = Ui.cleanLinks(message.text)
            textSize = 16f
            setTextColor(TEXT)
            maxWidth = (resources.displayMetrics.widthPixels * 0.8).toInt()
            textDirection = View.TEXT_DIRECTION_ANY_RTL
        })
        box.addView(TextView(this).apply {
            text = meta(message)
            textSize = 11f
            setTextColor(META)
        })
        row.addView(box, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val seq = message.seq
        val card = message.card
        if (!message.outgoing && seq != null && card != null) addCard(row, seq, card, message.cardState)
        if (!message.outgoing && seq != null && message.buttons.isNotEmpty()) {
            for (button in message.buttons) {
                row.addView(Button(this).apply {
                    text = button.title
                    isAllCaps = false
                    isEnabled = !message.answered && !Turns.busy
                    setOnClickListener {
                        if (!Turns.busy) {
                            Turns.press(this@ChatActivity, seq, button)
                            refresh()
                        }
                    }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }
        }
        return row
    }

    /**
     * Under a card: Run and Cancel while it is open; afterwards, one line saying
     * what became of it. Nothing about a card is in a notification (§6.20).
     */
    private fun addCard(row: LinearLayout, seq: Long, card: Row.Card, state: Int) {
        if (state == ChatStore.CARD_OPEN) {
            val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            buttons.addView(Button(this).apply {
                text = getString(R.string.card_run)
                isAllCaps = false
                setOnClickListener { Cards.run(this@ChatActivity, seq, card) }
            })
            buttons.addView(Button(this).apply {
                text = getString(R.string.card_cancel)
                isAllCaps = false
                setOnClickListener { Cards.refuse(this@ChatActivity, seq, card) }
            })
            row.addView(buttons)
            return
        }
        val line = when (state) {
            ChatStore.CARD_WORKING -> R.string.card_state_working
            ChatStore.CARD_DONE -> R.string.card_state_done
            ChatStore.CARD_REFUSED -> R.string.card_state_refused
            ChatStore.CARD_EXPIRED -> R.string.card_state_expired
            else -> R.string.card_state_failed
        }
        row.addView(TextView(this).apply {
            text = getString(line)
            textSize = 12f
            setTextColor(META)
            setPadding(dp(8), dp(2), dp(8), dp(2))
        })
    }

    private fun meta(message: ChatStore.Message): String {
        val time = Ui.isolate(formatTime(message.createdAt))
        return when {
            message.outgoing && message.state == ChatStore.STATE_SENDING -> getString(R.string.chat_meta_sending, time)
            message.outgoing && message.state == ChatStore.STATE_FAILED -> getString(R.string.chat_meta_failed, time)
            !message.outgoing && message.arrivedAt - message.createdAt > LATE_MS -> getString(R.string.chat_meta_late, time)
            else -> time
        }
    }

    private fun formatTime(at: Long): String {
        val then = Calendar.getInstance().apply { timeInMillis = at }
        val now = Calendar.getInstance()
        val sameDay = then.get(Calendar.YEAR) == now.get(Calendar.YEAR) &&
            then.get(Calendar.DAY_OF_YEAR) == now.get(Calendar.DAY_OF_YEAR)
        val pattern = if (sameDay) "HH:mm" else "d.M HH:mm"
        return SimpleDateFormat(pattern, Locale.ROOT).format(Date(at))
    }

    private companion object {
        const val REQUEST_MIC = 10
        /** Arrived more than ten minutes after it was written: say so, next to the original time. */
        const val LATE_MS = 10 * 60 * 1000L

        val BACKGROUND = Color.rgb(0xEC, 0xE5, 0xDD)
        val HEADER = Color.rgb(0x07, 0x5E, 0x54)
        val BANNER = Color.rgb(0xFF, 0xF3, 0xCD)
        val OUTGOING = Color.rgb(0xDC, 0xF8, 0xC6)
        val INCOMING = Color.WHITE
        val REMINDER = Color.rgb(0xFF, 0xF8, 0xE1)
        val NOTICE = Color.rgb(0xE1, 0xF0, 0xFA)
        val TEXT = Color.rgb(0x11, 0x1B, 0x21)
        val META = Color.rgb(0x66, 0x77, 0x81)
    }
}
