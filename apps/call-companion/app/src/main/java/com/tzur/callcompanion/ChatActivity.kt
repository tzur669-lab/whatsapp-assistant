package com.tzur.callcompanion

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.util.Linkify
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.ArrayAdapter
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListPopupWindow
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
 *
 * Several conversations, like an LLM client (0.5): ☰ opens the list, ＋ starts
 * a new one, and what the assistant sends on its own is in 🔔 תזכורות. A long
 * press copies a message; `/` in the field offers the commands.
 *
 * ＋ asks what kind of conversation to open (0.12): smart (Gemini) or local.
 * The kind is fixed for the conversation's life and shown in the header.
 * Shared text, the assistant, the widget and 🔔 תזכורות always open local.
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

    /** The conversation on screen: a uuid, or [ChatLogic.REMINDERS]. */
    private var current: String = ChatLogic.REMINDERS
    private lateinit var titleView: TextView
    private lateinit var modeBadge: TextView
    private lateinit var inputRow: LinearLayout
    private lateinit var readonlyNote: TextView
    private lateinit var drawer: LinearLayout
    private var locationButton: Button? = null
    private lateinit var scrim: View
    private val conversationsAdapter = ConversationsAdapter()
    private var conversations: List<ChatStore.Conversation> = emptyList()
    private lateinit var slashPopup: ListPopupWindow
    private var slashItems: List<ChatLogic.Command> = emptyList()
    /** The text a chosen command put in the field: not offered again for itself. */
    private var slashChosen: String? = null
    /** Text shared from another app (0.11), waiting for the user to say what to do with it. */
    private var pendingShared: String? = null
    private lateinit var shareBanner: TextView
    /**
     * 🎤 works by taps rather than by holding (0.11): armed when the chat is
     * opened as the assistant or from the widget. A tap starts the recording,
     * the next one sends it. Nothing records before the user's tap.
     */
    private var tapMode = false

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

        current = prefs().getString(PREF_CONVERSATION, null)
            ?: store.conversations().firstOrNull()?.id
            ?: Protocol.newMessageId()
        openFromNotification(intent)

        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
        if (savedInstanceState == null) openFrom(intent)

        // Once, the first time: the weather where the phone is (0.8). A no keeps /city.
        if (PhoneLocation.shouldAsk(this)) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), REQUEST_LOCATION)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::store.isInitialized) {
            openFromNotification(intent)
            openFrom(intent)
            refresh()
        }
    }

    /** A tapped notification opens the conversation its row is in. */
    private fun openFromNotification(intent: Intent?) {
        val seq = intent?.getLongExtra(EXTRA_SEQ, 0L) ?: 0L
        if (seq <= 0) return
        store.conversationOfSeq(seq)?.let { switchTo(it, refreshNow = false) }
    }

    /**
     * The chat opened as something more than the chat (0.11): text shared from
     * another app, the default assistant (long press on home), or a widget
     * button. None of them sends or records anything by itself.
     */
    private fun openFrom(intent: Intent?) {
        intent ?: return
        when {
            intent.action == Intent.ACTION_SEND -> {
                val shared = ChatLogic.sharedOf(
                    intent.getStringExtra(Intent.EXTRA_TEXT),
                    intent.getStringExtra(Intent.EXTRA_SUBJECT),
                )
                if (shared == null) {
                    Toast.makeText(this, R.string.share_empty, Toast.LENGTH_LONG).show()
                } else {
                    // Its own conversation: someone else's words do not join an ongoing one.
                    startNew()
                    pendingShared = shared
                    showShare()
                    focusInput()
                }
            }
            intent.action == Intent.ACTION_ASSIST -> {
                leaveReminders()
                armTapMode()
            }
            intent.getStringExtra(EXTRA_START) == START_VOICE -> {
                leaveReminders()
                armTapMode()
            }
            intent.getStringExtra(EXTRA_START) == START_TYPE -> {
                leaveReminders()
                focusInput()
            }
            intent.getStringExtra(EXTRA_START) == START_REMINDERS -> switchTo(ChatLogic.REMINDERS)
            else -> return
        }
        // Handled once: a rotation or a return to the app does not repeat it.
        setIntent(Intent(this, ChatActivity::class.java))
    }

    /** Nothing is written in the reminders conversation. */
    private fun leaveReminders() {
        if (current == ChatLogic.REMINDERS) startNew()
    }

    private fun focusInput() {
        input.requestFocus()
        input.post {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun armTapMode() {
        tapMode = true
        refresh()
    }

    private fun showShare() {
        val shared = pendingShared
        shareBanner.visibility = if (shared == null) View.GONE else View.VISIBLE
        input.hint = getString(if (shared == null) R.string.chat_hint else R.string.share_hint)
        if (shared != null) shareBanner.text = getString(R.string.share_banner, Ui.isolate(WidgetLogic.clip(shared)))
    }

    private fun cancelShare() {
        pendingShared = null
        showShare()
        refresh()
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::drawer.isInitialized && drawer.visibility == View.VISIBLE) return closeDrawer()
        @Suppress("DEPRECATION")
        super.onBackPressed()
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
        tapMode = false
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

        // In RTL the first child sits on the right: the menu, the title, then new and settings.
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(8), dp(8), dp(8))
            setBackgroundColor(HEADER)
        }
        header.addView(headerButton(R.string.chat_menu, R.string.chat_menu_description) { openDrawer() })
        titleView = TextView(this).apply {
            textSize = 18f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(8), 0, dp(8), 0)
        }
        header.addView(titleView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        // The conversation's kind (0.12), next to its title.
        modeBadge = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.argb(0x40, 0xFF, 0xFF, 0xFF))
            }
            setPadding(dp(8), dp(2), dp(8), dp(2))
            visibility = View.GONE
        }
        header.addView(modeBadge)
        header.addView(headerButton(R.string.chat_new, R.string.chat_new_description) { chooseNew() })
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
        val rows = adapter
        list = ListView(this).apply {
            divider = null
            transcriptMode = ListView.TRANSCRIPT_MODE_ALWAYS_SCROLL
            isStackFromBottom = true
            // Rows are not tappable; only the buttons inside them are.
            selector = ColorDrawable(Color.TRANSPARENT)
            adapter = rows
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

        readonlyNote = TextView(this).apply {
            text = getString(R.string.chat_reminders_readonly)
            textSize = 13f
            setTextColor(META)
            setPadding(dp(16), dp(10), dp(16), dp(12))
            visibility = View.GONE
            setOnClickListener { openDrawer() }
        }
        root.addView(readonlyNote)

        // Text shared from another app (0.11): shown above the field until sent; a tap drops it.
        shareBanner = TextView(this).apply {
            textSize = 13f
            setTextColor(TEXT)
            setBackgroundColor(NOTICE)
            maxLines = 3
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(16), dp(8), dp(16), dp(8))
            visibility = View.GONE
            contentDescription = getString(R.string.share_cancel_description)
            setOnClickListener { cancelShare() }
        }
        root.addView(shareBanner)

        // In RTL the first child sits on the right: the field, then send, then the microphone.
        inputRow = LinearLayout(this).apply {
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
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) = updateSlash(s?.toString().orEmpty())
            })
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

        slashPopup = ListPopupWindow(this).apply {
            anchorView = input
            isModal = false
            setOnItemClickListener { _, _, position, _ ->
                val command = slashItems.getOrNull(position) ?: return@setOnItemClickListener
                slashChosen = command.insert
                input.setText(command.insert)
                input.setSelection(input.text.length)
                dismiss()
            }
        }

        // The chat, and over it the menu of conversations with a dimmed backdrop.
        val shell = FrameLayout(this)
        shell.addView(root)
        scrim = View(this).apply {
            setBackgroundColor(Color.argb(0x66, 0, 0, 0))
            visibility = View.GONE
            setOnClickListener { closeDrawer() }
        }
        shell.addView(scrim)
        drawer = buildDrawer()
        val width = minOf(dp(320), (resources.displayMetrics.widthPixels * 0.85).toInt())
        shell.addView(drawer, FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START))

        Ui.fitSystemBars(shell)
        return shell
    }

    private fun headerButton(label: Int, description: Int, onClick: () -> Unit) = Button(this).apply {
        text = getString(label)
        contentDescription = getString(description)
        textSize = 20f
        setTextColor(Color.WHITE)
        background = null
        minWidth = dp(48)
        setOnClickListener { onClick() }
    }

    // -- conversations ----------------------------------------------------------

    private fun buildDrawer(): LinearLayout {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            elevation = dp(8).toFloat()
            isClickable = true
            visibility = View.GONE
            setPadding(dp(8), dp(12), dp(8), dp(8))
        }
        panel.addView(Button(this).apply {
            text = "${getString(R.string.chat_new)}  ${getString(R.string.chat_new_title)}"
            isAllCaps = false
            setOnClickListener { chooseNew() }
        })
        panel.addView(drawerItem(getString(R.string.chat_reminders), bold = true) { switchTo(ChatLogic.REMINDERS) })
        panel.addView(TextView(this).apply {
            text = getString(R.string.chat_conversations)
            textSize = 13f
            setTextColor(META)
            setPadding(dp(12), dp(16), dp(12), dp(4))
        })
        val list = ListView(this).apply {
            adapter = conversationsAdapter
            setOnItemClickListener { _, _, position, _ ->
                conversations.getOrNull(position)?.let { switchTo(it.id) }
            }
            setOnItemLongClickListener { _, _, position, _ ->
                conversations.getOrNull(position)?.let { confirmDelete(it) }
                true
            }
        }
        panel.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        locationButton = Button(this).apply {
            text = locationLabel()
            isAllCaps = false
            setOnClickListener { toggleLocation(this) }
        }
        panel.addView(locationButton)
        panel.addView(Button(this).apply {
            text = getString(R.string.quota_open)
            isAllCaps = false
            setOnClickListener {
                closeDrawer()
                startActivity(Intent(this@ChatActivity, QuotaActivity::class.java))
            }
        })
        panel.addView(Button(this).apply {
            text = getString(R.string.assistant_default)
            isAllCaps = false
            setOnClickListener {
                closeDrawer()
                openDefaultAppsSettings()
            }
        })
        panel.addView(Button(this).apply {
            text = getString(R.string.guide_open)
            isAllCaps = false
            setOnClickListener {
                closeDrawer()
                startActivity(Intent(this@ChatActivity, GuideActivity::class.java))
            }
        })
        return panel
    }

    /**
     * Where the user picks the default digital assistant (0.11). The role
     * cannot be requested by an app; the system settings are the only way.
     */
    private fun openDefaultAppsSettings() {
        Toast.makeText(this, R.string.assistant_default_hint, Toast.LENGTH_LONG).show()
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    /** On shows the town the phone was last found in, once it is known. */
    private fun locationLabel(): String {
        if (!PhoneLocation.isOn(this) || !PhoneLocation.granted(this)) return getString(R.string.location_off)
        val town = PhoneLocation.lastName ?: return getString(R.string.location_on)
        return getString(R.string.location_on_at, Ui.isolate(town))
    }

    /** Finds where the phone is now, off the main thread, and puts the town in the menu. */
    private fun refreshLocationLabel() {
        locationButton?.text = locationLabel()
        if (!PhoneLocation.isOn(this) || !PhoneLocation.granted(this)) return
        val app = applicationContext
        Thread {
            PhoneLocation.now(app)
            runOnUiThread { locationButton?.text = locationLabel() }
        }.start()
    }

    /** On asks for the permission when it is missing; off stops sending, whatever the permission. */
    private fun toggleLocation(button: Button) {
        val usable = PhoneLocation.isOn(this) && PhoneLocation.granted(this)
        if (usable) {
            PhoneLocation.setOn(this, false)
        } else {
            PhoneLocation.setOn(this, true)
            if (!PhoneLocation.granted(this)) {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), REQUEST_LOCATION)
            }
        }
        button.text = locationLabel()
        refreshLocationLabel()
    }

    private fun drawerItem(label: String, bold: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 16f
        setTextColor(TEXT)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        setOnClickListener { onClick() }
    }

    private fun openDrawer() {
        // The permission may have been changed in the system settings meanwhile,
        // and the phone may have moved.
        refreshLocationLabel()
        conversations = store.conversations()
        conversationsAdapter.notifyDataSetChanged()
        scrim.visibility = View.VISIBLE
        drawer.visibility = View.VISIBLE
        if (::slashPopup.isInitialized) slashPopup.dismiss()
    }

    private fun closeDrawer() {
        drawer.visibility = View.GONE
        scrim.visibility = View.GONE
    }

    private fun switchTo(conversation: String, refreshNow: Boolean = true) {
        current = conversation
        prefs().edit().putString(PREF_CONVERSATION, conversation).apply()
        if (::drawer.isInitialized) closeDrawer()
        if (refreshNow) refresh()
    }

    /**
     * A new conversation exists once its first message is sent; until then it
     * is only an id, and the kind chosen for it waits here (0.12). Opened by
     * anything but ＋, it is local.
     */
    private fun startNew(mode: String = Protocol.MODE_LOCAL) {
        val id = Protocol.newMessageId()
        prefs().edit().putString(PREF_DRAFT, id).putString(PREF_DRAFT_MODE, mode).apply()
        switchTo(id)
    }

    /** The kind chosen for a conversation that has no message yet, if it is [conversation]. */
    private fun draftMode(conversation: String): String? =
        prefs().takeIf { it.getString(PREF_DRAFT, null) == conversation }?.getString(PREF_DRAFT_MODE, null)

    /** The mode the conversation on screen goes with; null for 🔔 תזכורות. */
    private fun currentMode(): String? = ChatLogic.modeFor(current, store.modeOf(current), draftMode(current))

    /**
     * ＋: smart or local (0.12). Smart is offered only when the server last said
     * it can run one; otherwise it shows, disabled, as unavailable.
     */
    private fun chooseNew() {
        closeDrawer()
        val smartOn = ChatLogic.smartSelectable(ServerStatus.smart(this))
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            setPadding(dp(20), dp(8), dp(20), dp(4))
        }
        lateinit var dialog: AlertDialog
        fun option(label: Int, note: String, enabled: Boolean, mode: String) {
            panel.addView(Button(this).apply {
                text = getString(label)
                isAllCaps = false
                isEnabled = enabled
                setOnClickListener {
                    dialog.dismiss()
                    startNew(mode)
                }
            })
            panel.addView(TextView(this).apply {
                text = note
                textSize = 13f
                setTextColor(META)
                textDirection = View.TEXT_DIRECTION_ANY_RTL
                setPadding(dp(4), 0, dp(4), dp(12))
            })
        }
        option(
            R.string.mode_smart,
            if (smartOn) getString(R.string.mode_smart_note) else getString(R.string.mode_smart_unavailable),
            smartOn,
            Protocol.MODE_SMART,
        )
        option(R.string.mode_local, getString(R.string.mode_local_note), true, Protocol.MODE_LOCAL)
        panel.addView(TextView(this).apply {
            text = getString(R.string.mode_fixed)
            textSize = 12f
            setTextColor(META)
            setPadding(dp(4), 0, dp(4), dp(4))
        })
        dialog = AlertDialog.Builder(this)
            .setTitle(R.string.mode_choose_title)
            .setView(panel)
            .setNegativeButton(R.string.chat_keep, null)
            .create()
        dialog.show()
    }

    private fun confirmDelete(conversation: ChatStore.Conversation) {
        AlertDialog.Builder(this)
            .setTitle(R.string.chat_delete_title)
            .setMessage(conversation.title + "\n\n" + getString(R.string.chat_delete_text))
            .setPositiveButton(R.string.chat_delete) { _, _ ->
                store.deleteConversation(conversation.id)
                conversations = store.conversations()
                conversationsAdapter.notifyDataSetChanged()
                if (conversation.id == current) startNew()
            }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private inner class ConversationsAdapter : BaseAdapter() {
        override fun getCount(): Int = conversations.size
        override fun getItem(position: Int): Any = conversations[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val conversation = conversations[position]
            return LinearLayout(this@ChatActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                if (conversation.id == current) setBackgroundColor(SELECTED)
                addView(TextView(this@ChatActivity).apply {
                    text = conversation.title
                    textSize = 15f
                    setTextColor(TEXT)
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    textDirection = View.TEXT_DIRECTION_ANY_RTL
                })
                addView(TextView(this@ChatActivity).apply {
                    val time = Ui.isolate(formatTime(conversation.updatedAt))
                    text = if (conversation.mode == Protocol.MODE_SMART) "${getString(R.string.mode_badge_smart)} · $time" else time
                    textSize = 11f
                    setTextColor(META)
                })
            }
        }
    }

    // -- commands -----------------------------------------------------------------

    /** `/` at the start of the field offers the commands that match what is typed. */
    private fun updateSlash(text: String) {
        if (!::slashPopup.isInitialized) return
        if (text == slashChosen) {
            slashPopup.dismiss()
            return
        }
        slashChosen = null
        slashItems = ChatLogic.commandsFor(text)
        if (slashItems.isEmpty() || !input.hasFocus()) {
            slashPopup.dismiss()
            return
        }
        slashPopup.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_list_item_1, slashItems.map { "${Ui.isolate(it.usage)}   ${it.description}" }),
        )
        slashPopup.height = if (slashItems.size > 5) dp(300) else ViewGroup.LayoutParams.WRAP_CONTENT
        slashPopup.show()
    }

    // -- copying ------------------------------------------------------------------

    /** A long press copies a message as plain text: links whole, no direction marks. */
    private fun copy(text: String) {
        val plain = Ui.cleanLinks(text).replace(DIRECTION_MARKS, "")
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("message", plain))
        Toast.makeText(this, R.string.chat_copied, Toast.LENGTH_SHORT).show()
    }

    // -- sending ----------------------------------------------------------------

    private fun sendTyped() {
        val text = input.text.toString().trim()
        if (text.isEmpty() || Turns.busy || current == ChatLogic.REMINDERS) return
        val shared = pendingShared
        if (shared != null && !ChatLogic.canSendWithShared(text)) {
            Toast.makeText(this, R.string.share_no_command, Toast.LENGTH_LONG).show()
            return
        }
        Turns.sendText(this, text, current, shared, currentMode())
        input.text.clear()
        pendingShared = null
        showShare()
        refresh()
    }

    private fun onMicTouch(view: View, event: MotionEvent): Boolean {
        if (tapMode) {
            // A tap starts, the next tap sends (0.11).
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                if (recorder.isRecording) {
                    tapMode = false
                    finishRecording()
                } else {
                    startRecording()
                }
                view.performClick()
            }
            return true
        }
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
            Turns.sendVoice(this, recording.audio, getString(R.string.chat_voice_label, length), current, currentMode())
        }
        refresh()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_LOCATION) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            Toast.makeText(this, if (granted) R.string.location_ready else R.string.location_denied, Toast.LENGTH_LONG).show()
            refreshLocationLabel()
            return
        }
        if (requestCode != REQUEST_MIC) return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        Toast.makeText(this, if (granted) R.string.chat_mic_ready else R.string.chat_mic_permission, Toast.LENGTH_LONG).show()
    }

    // -- state ------------------------------------------------------------------

    private fun refresh() {
        if (!::store.isInitialized) return
        messages = store.all(current)
        adapter.notifyDataSetChanged()
        empty.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE

        val reminders = current == ChatLogic.REMINDERS
        val title = if (reminders) null else store.titleOf(current)
        titleView.text = when {
            reminders -> getString(R.string.chat_reminders)
            title != null -> title
            else -> getString(R.string.chat_new_title)
        }
        val mode = currentMode()
        modeBadge.visibility = if (mode == null) View.GONE else View.VISIBLE
        modeBadge.text = getString(if (mode == Protocol.MODE_SMART) R.string.mode_badge_smart else R.string.mode_badge_local)
        empty.text = getString(
            when {
                reminders -> R.string.chat_reminders_empty
                title == null -> R.string.chat_new_empty
                else -> R.string.chat_empty
            },
        )
        // Nothing is written to the reminders: it holds what the assistant sends on its own.
        inputRow.visibility = if (reminders) View.GONE else View.VISIBLE
        readonlyNote.visibility = if (reminders) View.VISIBLE else View.GONE
        if (drawer.visibility == View.VISIBLE) {
            conversations = store.conversations()
            conversationsAdapter.notifyDataSetChanged()
        }

        val busy = Turns.busy
        sendButton.isEnabled = !busy
        // Shared text goes with a typed request only: a recording carries no second field.
        micButton.isEnabled = (!busy && pendingShared == null) || recorder.isRecording
        val armed = tapMode && !reminders && !busy
        status.visibility = if (busy || recorder.isRecording || armed) View.VISIBLE else View.GONE
        status.text = getString(
            when {
                recorder.isRecording && tapMode -> R.string.chat_recording_tap
                recorder.isRecording -> R.string.chat_recording
                busy -> R.string.chat_busy
                else -> R.string.chat_tap_to_talk
            },
        )
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
        // Nothing this phone showed stays on the home screen once it is unpaired.
        if (unpairedByServer) AssistantWidget.clear(this)
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
            // A long press copies — on the text too, which otherwise takes the touch for its links.
            setOnLongClickListener {
                copy(message.text)
                true
            }
        })
        box.setOnLongClickListener {
            copy(message.text)
            true
        }
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

    companion object {
        /** On a notification's intent: the row it shows, to open its conversation. */
        const val EXTRA_SEQ = "seq"
        /** On a widget button's intent (0.11): what to open the chat ready for. */
        const val EXTRA_START = "start"
        const val START_TYPE = "type"
        const val START_VOICE = "voice"
        const val START_REMINDERS = "reminders"

        private const val PREFS = "chat"
        private const val PREF_CONVERSATION = "conversation"
        /** A conversation opened by ＋ before its first message, and the kind chosen for it (0.12). */
        private const val PREF_DRAFT = "draft_conversation"
        private const val PREF_DRAFT_MODE = "draft_mode"
        private val DIRECTION_MARKS = Regex("[\\u200E\\u200F\\u2066-\\u2069]")
        private val SELECTED = Color.rgb(0xE8, 0xF5, 0xE9)

        private const val REQUEST_MIC = 10
        private const val REQUEST_LOCATION = 11
        /** Arrived more than ten minutes after it was written: say so, next to the original time. */
        private const val LATE_MS = 10 * 60 * 1000L

        private val BACKGROUND = Color.rgb(0xEC, 0xE5, 0xDD)
        private val HEADER = Color.rgb(0x07, 0x5E, 0x54)
        private val BANNER = Color.rgb(0xFF, 0xF3, 0xCD)
        private val OUTGOING = Color.rgb(0xDC, 0xF8, 0xC6)
        private val INCOMING = Color.WHITE
        private val REMINDER = Color.rgb(0xFF, 0xF8, 0xE1)
        private val NOTICE = Color.rgb(0xE1, 0xF0, 0xFA)
        private val TEXT = Color.rgb(0x11, 0x1B, 0x21)
        private val META = Color.rgb(0x66, 0x77, 0x81)
    }
}
