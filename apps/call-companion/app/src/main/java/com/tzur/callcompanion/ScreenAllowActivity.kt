package com.tzur.callcompanion

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * The screen agent's allowlist (0.14): ☰ → ⚙️ סוכן מסך. The apps the agent may
 * act in, each with "ask before every tap" (off by default), and the
 * disclosure of where an app's text goes. Settings, the system UI, launchers,
 * messaging, mail, banks and payments can never be added ([ScreenLogic.blocked]).
 * Every change is synced to the server; removing an app stops a task in it.
 */
class ScreenAllowActivity : Activity() {

    private lateinit var column: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }
        val scroll = ScrollView(this).apply { addView(column) }
        Ui.fitSystemBars(scroll)
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun render() {
        column.removeAllViews()
        column.addView(heading(getString(R.string.screen_title), 24f))
        column.addView(paragraph(getString(R.string.screen_intro)))
        column.addView(disclosure())

        if (RoutineAccessibilityService.isOn) {
            column.addView(paragraph(getString(R.string.screen_service_on)))
        } else {
            column.addView(paragraph(getString(R.string.screen_service_off)))
            column.addView(button(getString(R.string.routines_service_open)) { openAccessibilitySettings() })
            column.addView(paragraph(getString(R.string.perm_restricted_note)).apply { textSize = 13f })
        }

        column.addView(heading(getString(R.string.screen_apps_title), 18f))
        val apps = ScreenAllowStore.all(this)
        if (apps.isEmpty()) column.addView(paragraph(getString(R.string.screen_apps_empty)))
        apps.forEach { column.addView(appRow(it)) }
        if (apps.size < ScreenLogic.MAX_APPS) {
            column.addView(button(getString(R.string.screen_add)) { chooseApp() })
        } else {
            column.addView(paragraph(getString(R.string.screen_full)))
        }
        column.addView(paragraph(getString(R.string.screen_blocked_note)).apply { textSize = 13f })
    }

    private fun appRow(app: ScreenLogic.AllowedApp): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.rgb(0xF1, 0xF3, 0xF4))
            }
        }
        box.addView(TextView(this).apply {
            text = Ui.isolate(app.label.ifBlank { app.packageName })
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            textDirection = View.TEXT_DIRECTION_RTL
        })
        box.addView(Switch(this).apply {
            text = getString(R.string.screen_ask_every_tap)
            isChecked = app.askEveryTap
            setOnCheckedChangeListener { _, checked -> save(app.copy(askEveryTap = checked)) }
        })
        box.addView(Button(this).apply {
            text = getString(R.string.screen_remove)
            isAllCaps = false
            setOnClickListener {
                ScreenAllowStore.remove(this@ScreenAllowActivity, app.packageName)
                render()
            }
        })
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(4))
            addView(box, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun save(app: ScreenLogic.AllowedApp) {
        if (!ScreenAllowStore.put(this, app)) Toast.makeText(this, R.string.screen_full, Toast.LENGTH_SHORT).show()
    }

    /** Launchable apps not listed yet and not blocked, by label. */
    private fun chooseApp() {
        val pm = packageManager
        val launchers = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
            .map { it.activityInfo.packageName }
            .toSet()
        val listed = ScreenAllowStore.all(this).map { it.packageName }.toSet()
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .filter { (_, pkg) -> pkg !in listed && ScreenLogic.validPackage(pkg) && !ScreenLogic.blocked(pkg, packageName, launchers) }
            .sortedBy { it.first.lowercase() }
        if (apps.isEmpty()) {
            Toast.makeText(this, R.string.screen_choose_none, Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.screen_choose)
            .setItems(apps.map { it.first }.toTypedArray()) { _, which -> confirmAdd(apps[which].first, apps[which].second) }
            .show()
    }

    /** The disclosure again, for this app, before it is added. */
    private fun confirmAdd(label: String, packageName: String) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.screen_add_confirm_title, Ui.isolate(label)))
            .setMessage(R.string.screen_disclosure)
            .setPositiveButton(R.string.screen_add_confirm_go) { _, _ ->
                save(ScreenLogic.AllowedApp(packageName, label.take(ScreenLogic.MAX_APP_LABEL), askEveryTap = false))
                render()
            }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private fun openAccessibilitySettings() {
        try {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    // --- Views ---

    private fun disclosure() = paragraph(getString(R.string.screen_disclosure)).apply {
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = GradientDrawable().apply {
            cornerRadius = dp(10).toFloat()
            setColor(Color.rgb(0xFF, 0xF4, 0xE5))
        }
    }

    private fun heading(text: String, size: Float) = TextView(this).apply {
        this.text = text
        textSize = size
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(16), 0, dp(4))
    }

    private fun paragraph(text: String) = TextView(this).apply {
        this.text = text
        textSize = 15f
        setLineSpacing(0f, 1.15f)
        textDirection = View.TEXT_DIRECTION_ANY_RTL
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setOnClickListener { onClick() }
    }
}
