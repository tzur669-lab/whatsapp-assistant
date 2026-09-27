package com.tzur.callcompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
 * Pairing and permissions. Everything the app does afterwards happens from a
 * push, so this screen exists to be set up once and then forgotten.
 */
class MainActivity : Activity() {
    private lateinit var vault: TokenVault
    private lateinit var status: TextView
    private lateinit var codeField: EditText
    private lateinit var pairButton: Button
    private lateinit var unpairButton: Button
    private val permissionRows = mutableListOf<Pair<Button, () -> Boolean>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = TokenVault(this)
        CallNotifier.ensureChannel(this)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun buildLayout(): View {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        column.addView(heading(getString(R.string.app_name), 24f))
        status = TextView(this).apply { textSize = 16f }
        column.addView(status)

        column.addView(TextView(this).apply {
            text = getString(R.string.pair_instructions)
            setPadding(0, pad, 0, 0)
        })
        codeField = EditText(this).apply {
            hint = getString(R.string.pair_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            textDirection = View.TEXT_DIRECTION_LTR
            typeface = Typeface.MONOSPACE
            isSingleLine = true
        }
        column.addView(codeField)
        pairButton = Button(this).apply {
            text = getString(R.string.button_pair)
            setOnClickListener { pair() }
        }
        column.addView(pairButton)
        unpairButton = Button(this).apply {
            text = getString(R.string.button_unpair)
            setOnClickListener {
                vault.clear()
                status.text = getString(R.string.unpaired_note)
                refresh(keepStatus = true)
            }
        }
        column.addView(unpairButton)

        column.addView(heading(getString(R.string.perm_title), 20f).apply { setPadding(0, pad, 0, 0) })
        permissionRow(column, R.string.perm_contacts, { granted(Manifest.permission.READ_CONTACTS) }) {
            requestPermissions(arrayOf(Manifest.permission.READ_CONTACTS), 1)
        }
        permissionRow(column, R.string.perm_phone, { granted(Manifest.permission.CALL_PHONE) }) {
            requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), 2)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            permissionRow(column, R.string.perm_notifications, { granted(Manifest.permission.POST_NOTIFICATIONS) }) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
            }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            permissionRow(column, R.string.perm_fullscreen, { CallNotifier.canUseFullScreen(this) }) {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")),
                )
            }
        }

        column.addView(TextView(this).apply {
            text = getString(R.string.privacy_note)
            setPadding(0, pad, 0, 0)
            textSize = 13f
        })

        return ScrollView(this).apply { addView(column) }
    }

    private fun heading(text: String, size: Float) = TextView(this).apply {
        this.text = text
        textSize = size
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun permissionRow(column: LinearLayout, label: Int, isGranted: () -> Boolean, request: () -> Unit) {
        column.addView(TextView(this).apply { text = getString(label) })
        val button = Button(this).apply { setOnClickListener { request() } }
        column.addView(button)
        permissionRows += button to isGranted
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh(keepStatus = true)
    }

    private fun refresh(keepStatus: Boolean = false) {
        val paired = vault.get() != null
        if (!keepStatus) status.text = getString(if (paired) R.string.status_paired else R.string.status_unpaired)
        unpairButton.visibility = if (paired) View.VISIBLE else View.GONE
        for ((button, isGranted) in permissionRows) {
            val ok = isGranted()
            button.text = getString(if (ok) R.string.perm_ok else R.string.perm_grant)
            button.isEnabled = !ok
        }
    }

    private fun pair() {
        val code = codeField.text.toString().trim()
        if (!CODE.matches(code)) {
            status.text = getString(R.string.pair_failed)
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
            Thread {
                val result = Api.pair(code, pushToken)
                runOnUiThread {
                    pairButton.isEnabled = true
                    when (result) {
                        is Api.PairResult.Paired -> {
                            vault.set(result.deviceToken)
                            codeField.text.clear()
                            refresh()
                        }
                        Api.PairResult.Refused -> status.text = getString(R.string.pair_failed)
                        Api.PairResult.Unreachable -> status.text = getString(R.string.pair_network)
                    }
                }
            }.start()
        }
    }

    private companion object {
        val CODE = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
