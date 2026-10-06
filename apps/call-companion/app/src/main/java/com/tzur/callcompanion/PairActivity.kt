package com.tzur.callcompanion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Pairing, permissions and battery (PLAN §6.18). Opened on first run, when the
 * server no longer knows the phone, and from the chat's settings button.
 *
 * The code is typed here and never sent: the app makes a Keystore key and
 * proves it knows the code with an HMAC over that key ([Protocol.pairingMac]).
 */
class PairActivity : Activity() {
    private lateinit var signer: Signer
    private lateinit var status: TextView
    private lateinit var codeField: EditText
    private lateinit var pairButton: Button
    private lateinit var chatButton: Button
    private val permissionRows = mutableListOf<Pair<Button, () -> Boolean>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        signer = Signer(this)
        Notifier.ensureChannels(this)
        CallNotifier.ensureChannel(this)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
        if (intent.getBooleanExtra(EXTRA_UNPAIRED, false)) status.text = getString(R.string.status_unpaired_by_server)
    }

    override fun onResume() {
        super.onResume()
        refresh(keepStatus = intent.getBooleanExtra(EXTRA_UNPAIRED, false) && !signer.isPaired)
    }

    private fun buildLayout(): View {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        column.addView(heading(getString(R.string.pair_title), 24f))
        status = TextView(this).apply { textSize = 16f }
        column.addView(status)

        chatButton = Button(this).apply {
            text = getString(R.string.button_open_chat)
            isAllCaps = false
            setOnClickListener { openChat() }
        }
        column.addView(chatButton)
        column.addView(Button(this).apply {
            text = getString(R.string.guide_open)
            isAllCaps = false
            setOnClickListener { startActivity(Intent(this@PairActivity, GuideActivity::class.java)) }
        })
        column.addView(Button(this).apply {
            text = getString(R.string.quota_open)
            isAllCaps = false
            setOnClickListener { startActivity(Intent(this@PairActivity, QuotaActivity::class.java)) }
        })

        column.addView(TextView(this).apply {
            text = getString(R.string.pair_instructions)
            setPadding(0, pad, 0, 0)
        })
        codeField = EditText(this).apply {
            hint = getString(R.string.pair_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            textDirection = View.TEXT_DIRECTION_LTR
            typeface = Typeface.MONOSPACE
            isSingleLine = true
        }
        column.addView(codeField)
        pairButton = Button(this).apply {
            text = getString(R.string.button_pair)
            isAllCaps = false
            setOnClickListener { pair() }
        }
        column.addView(pairButton)
        column.addView(TextView(this).apply {
            text = getString(R.string.unpair_note)
            textSize = 13f
        })

        column.addView(heading(getString(R.string.perm_title), 20f).apply { setPadding(0, pad, 0, 0) })
        if (Build.VERSION.SDK_INT >= 33) {
            permissionRow(column, R.string.perm_notifications, { granted(Manifest.permission.POST_NOTIFICATIONS) }) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
            }
        }
        permissionRow(column, R.string.perm_battery, { batteryUnrestricted() }) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        permissionRow(column, R.string.perm_microphone, { granted(Manifest.permission.RECORD_AUDIO) }) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 4)
        }
        permissionRow(column, R.string.perm_contacts, { granted(Manifest.permission.READ_CONTACTS) }) {
            requestPermissions(arrayOf(Manifest.permission.READ_CONTACTS), 1)
        }
        permissionRow(column, R.string.perm_phone, { granted(Manifest.permission.CALL_PHONE) }) {
            requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), 2)
        }
        if (Build.VERSION.SDK_INT >= 34) {
            permissionRow(column, R.string.perm_fullscreen, { CallNotifier.canUseFullScreen(this) }) {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")),
                )
            }
        }

        // Phone reads (PLAN §6.21): each one optional, each one its own grant.
        column.addView(heading(getString(R.string.perm_reads_title), 18f).apply { setPadding(0, pad, 0, 0) })
        permissionRow(column, R.string.perm_sms, { granted(Manifest.permission.READ_SMS) }) {
            requestPermissions(arrayOf(Manifest.permission.READ_SMS), 5)
        }
        permissionRow(column, R.string.perm_call_log, { granted(Manifest.permission.READ_CALL_LOG) }) {
            requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG), 7)
        }
        permissionRow(column, R.string.perm_notification_access, { NotificationBuffer.isEnabled(this) }) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        column.addView(TextView(this).apply {
            text = getString(R.string.perm_restricted_note)
            textSize = 13f
        })
        column.addView(TextView(this).apply {
            text = getString(R.string.perm_hide_apps)
            setPadding(0, pad / 2, 0, 0)
        })
        column.addView(Button(this).apply {
            text = getString(R.string.button_choose)
            isAllCaps = false
            setOnClickListener { chooseHiddenApps() }
        })

        column.addView(TextView(this).apply {
            text = getString(R.string.privacy_note)
            setPadding(0, pad, 0, 0)
            textSize = 13f
        })

        val scroll = ScrollView(this).apply { addView(column) }
        Ui.fitSystemBars(scroll)
        return scroll
    }

    /**
     * Which apps' notifications are never kept. The list is the apps seen in the
     * last day plus those already hidden; a hidden app's kept rows go at once.
     */
    private fun chooseHiddenApps() {
        val hidden = NotificationBuffer.hidden(this)
        val seen = NotificationBuffer.get(this).seenApps().toMap(LinkedHashMap())
        for (packageName in hidden) seen.putIfAbsent(packageName, packageName)
        if (seen.isEmpty()) {
            AlertDialog.Builder(this).setMessage(R.string.hide_apps_empty).setPositiveButton(android.R.string.ok, null).show()
            return
        }
        val packages = seen.keys.toList()
        val checked = BooleanArray(packages.size) { packages[it] in hidden }
        AlertDialog.Builder(this)
            .setTitle(R.string.hide_apps_title)
            .setMultiChoiceItems(packages.map { seen[it] }.toTypedArray(), checked) { _, which, isChecked -> checked[which] = isChecked }
            .setPositiveButton(R.string.button_save) { _, _ ->
                NotificationBuffer.setHidden(this, packages.filterIndexed { index, _ -> checked[index] }.toSet())
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun heading(text: String, size: Float) = TextView(this).apply {
        this.text = text
        textSize = size
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun permissionRow(column: LinearLayout, label: Int, isGranted: () -> Boolean, request: () -> Unit) {
        column.addView(TextView(this).apply { text = getString(label) })
        val button = Button(this).apply {
            isAllCaps = false
            setOnClickListener { request() }
        }
        column.addView(button)
        permissionRows += button to isGranted
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun batteryUnrestricted(): Boolean =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh(keepStatus = true)
    }

    private fun refresh(keepStatus: Boolean = false) {
        val paired = signer.isPaired
        if (!keepStatus) status.text = getString(if (paired) R.string.status_paired else R.string.status_unpaired)
        chatButton.visibility = if (paired) View.VISIBLE else View.GONE
        for ((button, isGranted) in permissionRows) {
            val ok = isGranted()
            button.text = getString(if (ok) R.string.perm_ok else R.string.perm_grant)
            button.isEnabled = !ok
        }
    }

    private fun pair() {
        val code = Protocol.normalizePairingCode(codeField.text.toString())
        if (code == null) {
            status.text = getString(R.string.pair_bad_code)
            return
        }
        status.text = getString(R.string.pairing)
        pairButton.isEnabled = false

        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            val pushToken = if (task.isSuccessful) task.result else null
            if (pushToken.isNullOrEmpty()) {
                status.text = getString(R.string.pair_no_push)
                pairButton.isEnabled = true
                return@addOnCompleteListener
            }
            val app = applicationContext
            Thread {
                val outcome = try {
                    // The same pending key on every attempt until one succeeds: a
                    // retry after a lost answer gets the same device back.
                    val publicKey = signer.pendingPublicKey()
                    val timestamp = System.currentTimeMillis()
                    val mac = Protocol.pairingMac(code, publicKey, pushToken, timestamp)
                    when (val result = Api.pair(publicKey, pushToken, timestamp, mac)) {
                        is Api.PairResult.Paired -> {
                            signer.completePairing(result.deviceId)
                            PushToken.markSent(app)
                            R.string.status_paired
                        }
                        Api.PairResult.Refused -> R.string.pair_failed
                        Api.PairResult.Unreachable -> R.string.pair_network
                    }
                } catch (_: Exception) {
                    R.string.pair_key_failed
                }
                runOnUiThread {
                    pairButton.isEnabled = true
                    status.text = getString(outcome)
                    if (outcome == R.string.status_paired) {
                        codeField.text.clear()
                        intent.removeExtra(EXTRA_UNPAIRED)
                        refresh(keepStatus = true)
                        // Anything held while no phone was paired comes now.
                        Thread { Sync.run(app, Api.SHORT_TIMEOUT_MS) }.start()
                        openChat()
                    }
                }
            }.start()
        }
    }

    private fun openChat() {
        startActivity(Intent(this, ChatActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    companion object {
        const val EXTRA_UNPAIRED = "unpaired_by_server"
    }
}
