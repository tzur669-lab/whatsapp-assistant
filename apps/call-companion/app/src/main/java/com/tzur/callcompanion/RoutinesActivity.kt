package com.tzur.callcompanion

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.UUID

/**
 * The routines screen (0.13): build, edit, delete, a dry run that taps
 * nothing, and a run now. Opened from the chat's menu. A run's result comes
 * back here through [onNewIntent], since the run leaves this screen for the
 * routine's app.
 */
class RoutinesActivity : Activity() {

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
        showResult(intent)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        showResult(intent)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun render() {
        column.removeAllViews()
        column.addView(heading(getString(R.string.routines_title), 24f))
        column.addView(paragraph(getString(R.string.routines_intro)))

        if (RoutineAccessibilityService.isOn) {
            column.addView(paragraph(getString(R.string.routines_service_on)))
        } else {
            column.addView(paragraph(getString(R.string.routines_service_off)))
            column.addView(button(getString(R.string.routines_service_open)) { openAccessibilitySettings() })
            column.addView(paragraph(getString(R.string.perm_restricted_note)).apply { textSize = 13f })
        }

        column.addView(heading(getString(R.string.routines_list_title), 18f))
        val routines = RoutineStore.all(this)
        if (routines.isEmpty()) column.addView(paragraph(getString(R.string.routines_empty)))
        else column.addView(paragraph(getString(R.string.routines_numbers_note)).apply { textSize = 13f })
        // The number the assistant knows it by too: "תפעיל שגרה 2" (2026-10-12).
        routines.forEachIndexed { index, routine -> column.addView(routineRow(routine, index + 1)) }
        if (routines.size < RoutineLogic.MAX_ROUTINES) column.addView(button(getString(R.string.routines_new)) { edit(null) })
        unlockSection()
    }

    // --- Unlocking with the stored PIN (0.17) ---

    private fun unlockSection() {
        column.addView(heading(getString(R.string.unlock_title), 18f))
        if (Build.VERSION.SDK_INT < UnlockLogic.MIN_SDK) {
            column.addView(paragraph(getString(R.string.unlock_old_android)))
            return
        }
        column.addView(paragraph(getString(R.string.unlock_intro)).apply { textSize = 14f })
        val hasPin = UnlockStore.hasPin(this)
        val status = when {
            !hasPin -> R.string.unlock_status_none
            UnlockStore.failed(this) -> R.string.unlock_status_failed
            else -> R.string.unlock_status_saved
        }
        column.addView(paragraph(getString(status)))
        column.addView(button(getString(if (hasPin) R.string.unlock_replace else R.string.unlock_save)) { askPin() })
        if (hasPin) column.addView(button(getString(R.string.unlock_remove)) { confirmRemovePin() })
    }

    /** The PIN typed twice; never shown, never kept in a String of ours. */
    private fun askPin() {
        val first = pinField(R.string.unlock_pin_hint)
        val second = pinField(R.string.unlock_pin_again_hint)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(first)
            addView(second)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.unlock_dialog_title)
            .setView(box)
            .setPositiveButton(R.string.unlock_save) { _, _ ->
                val a = charsOf(first)
                val b = charsOf(second)
                first.text.clear()
                second.text.clear()
                val message = when {
                    UnlockLogic.pinProblem(a) != null -> R.string.unlock_pin_bad
                    !UnlockLogic.sameEntry(a, b) -> R.string.unlock_pin_mismatch
                    UnlockStore.savePin(this, a) -> R.string.unlock_saved
                    else -> R.string.unlock_save_failed
                }
                a.fill('0')
                b.fill('0')
                android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
                render()
            }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private fun pinField(hint: Int) = EditText(this).apply {
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        setHint(hint)
        filters = arrayOf(android.text.InputFilter.LengthFilter(UnlockLogic.MAX_DIGITS))
        textDirection = View.TEXT_DIRECTION_LTR
    }

    private fun charsOf(field: EditText): CharArray {
        val text = field.text
        return CharArray(text.length) { text[it] }
    }

    private fun confirmRemovePin() {
        AlertDialog.Builder(this)
            .setTitle(R.string.unlock_remove_title)
            .setMessage(R.string.unlock_remove_text)
            .setPositiveButton(R.string.chat_delete) { _, _ ->
                UnlockStore.clear(this)
                render()
            }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private fun routineRow(routine: RoutineLogic.Routine, number: Int): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.rgb(0xF1, 0xF3, 0xF4))
            }
        }
        box.addView(TextView(this).apply {
            text = getString(R.string.routine_numbered, number, Ui.isolate(routine.name))
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            // RTL always: the name is isolated, so nothing outside it is a strong
            // letter, and "any RTL" fell back to LTR — the number went left.
            textDirection = View.TEXT_DIRECTION_RTL
        })
        box.addView(TextView(this).apply {
            text = resources.getQuantityString(
                R.plurals.routine_summary, routine.steps.size, Ui.isolate(routine.appLabel), routine.steps.size,
            )
            textSize = 14f
        })
        if (!routine.verifies) {
            box.addView(TextView(this).apply {
                text = getString(R.string.routine_no_verify_note)
                textSize = 13f
                setTextColor(Color.rgb(0x8A, 0x5A, 0x00))
            })
        }
        // Off by default; an edit of the steps turns it off (UnlockStore keeps the step hash).
        if (UnlockStore.hasPin(this) && Build.VERSION.SDK_INT >= UnlockLogic.MIN_SDK) {
            box.addView(CheckBox(this).apply {
                text = getString(R.string.unlock_routine_switch)
                textSize = 14f
                isChecked = UnlockStore.isOptedIn(this@RoutinesActivity, routine)
                setOnCheckedChangeListener { _, on -> UnlockStore.setOptIn(this@RoutinesActivity, routine, on) }
            })
        }
        // Two rows: five buttons in one squeezed "מחיקה" to nothing on a phone.
        val runRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        runRow.addView(smallButton(getString(R.string.routine_scan)) { scan(routine) })
        runRow.addView(smallButton(getString(R.string.routine_dry)) { run(routine, dryRun = true) })
        runRow.addView(smallButton(getString(R.string.routine_run)) { confirmRun(routine) })
        box.addView(runRow)
        val editRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        editRow.addView(smallButton(getString(R.string.routine_edit)) { edit(routine) })
        editRow.addView(smallButton(getString(R.string.routine_delete)) { confirmDelete(routine) })
        box.addView(editRow)
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(4))
            addView(box)
        }
    }

    // --- Running ---

    private fun confirmRun(routine: RoutineLogic.Routine) {
        AlertDialog.Builder(this)
            .setTitle(R.string.routine_run_confirm_title)
            .setMessage(getString(R.string.routine_run_confirm_text, Ui.isolate(routine.appLabel)))
            .setPositiveButton(R.string.routine_run_go) { _, _ -> run(routine, dryRun = false) }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private fun run(routine: RoutineLogic.Routine, dryRun: Boolean) {
        val app = applicationContext
        val started = RoutineAccessibilityService.run(routine, dryRun) { result ->
            // Back to this screen with the result; the run left it for the routine's app.
            val back = Intent(app, RoutinesActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(EXTRA_OUTCOME, result.outcome.name)
                .putExtra(EXTRA_STEP, result.step)
                .putExtra(EXTRA_REASON, result.reason)
            app.startActivity(back)
        }
        if (!started) {
            AlertDialog.Builder(this)
                .setMessage(R.string.routines_service_off)
                .setPositiveButton(R.string.routines_service_open) { _, _ -> openAccessibilitySettings() }
                .setNegativeButton(R.string.chat_keep, null)
                .show()
        }
    }

    private fun scan(routine: RoutineLogic.Routine) {
        val app = applicationContext
        val started = RoutineAccessibilityService.scan(routine.packageName) { lines ->
            val back = Intent(app, RoutinesActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(EXTRA_SCAN, ArrayList(lines.orEmpty().map { scanLineText(it) }))
                .putExtra(EXTRA_SCAN_OK, lines != null)
            app.startActivity(back)
        }
        if (!started) {
            AlertDialog.Builder(this)
                .setMessage(R.string.routines_service_off)
                .setPositiveButton(R.string.routines_service_open) { _, _ -> openAccessibilitySettings() }
                .setNegativeButton(R.string.chat_keep, null)
                .show()
        }
    }

    /** One scan line as the user reads it: the words, then what kind of element it is. */
    private fun scanLineText(line: RoutineLogic.ScanLine): String {
        val parts = ArrayList<String>()
        line.text?.let { parts.add(Ui.isolate("\"$it\"")) }
        line.hint?.let { parts.add(getString(R.string.scan_hint, Ui.isolate("\"$it\""))) }
        line.viewId?.let { parts.add(getString(R.string.scan_id, Ui.isolate(it))) }
        val flags = ArrayList<String>()
        flags.add(getString(if (line.clickable) R.string.scan_clickable else R.string.scan_not_clickable))
        if (!line.enabled) flags.add(getString(R.string.scan_disabled))
        if (line.editable) flags.add(getString(R.string.scan_editable))
        return parts.joinToString(" · ") + "\n   " + flags.joinToString(", ")
    }

    private fun showScan(intent: Intent?): Boolean {
        val lines = intent?.getStringArrayListExtra(EXTRA_SCAN) ?: return false
        val ok = intent.getBooleanExtra(EXTRA_SCAN_OK, false)
        intent.removeExtra(EXTRA_SCAN)
        val message = when {
            !ok -> getString(R.string.scan_failed)
            lines.isEmpty() -> getString(R.string.scan_empty)
            else -> lines.joinToString("\n\n")
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.scan_title)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
        return true
    }

    private fun showResult(intent: Intent?) {
        if (showScan(intent)) return
        val outcomeName = intent?.getStringExtra(EXTRA_OUTCOME) ?: return
        intent.removeExtra(EXTRA_OUTCOME)
        val outcome = RoutineLogic.Outcome.entries.firstOrNull { it.name == outcomeName } ?: return
        val step = intent.getIntExtra(EXTRA_STEP, -1)
        val where = if (step < 0) getString(R.string.routine_where_open) else getString(R.string.routine_where_step, step + 1)
        val reason = reasonText(intent.getStringExtra(EXTRA_REASON).orEmpty())
        val message = when (outcome) {
            RoutineLogic.Outcome.VERIFIED -> getString(R.string.routine_result_verified)
            RoutineLogic.Outcome.TAPPED_UNVERIFIED -> getString(R.string.routine_result_unverified)
            RoutineLogic.Outcome.FAILED_BEFORE_TAP -> getString(R.string.routine_result_failed_before, where, reason)
            RoutineLogic.Outcome.FAILED_AFTER_TAP -> getString(R.string.routine_result_failed_after, where, reason)
            RoutineLogic.Outcome.DRY_RUN_OK -> getString(R.string.routine_result_dry_ok)
            RoutineLogic.Outcome.BLOCKED -> getString(R.string.routine_result_blocked)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.routine_result_title)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun reasonText(code: String): String = getString(
        when (code) {
            "locked" -> R.string.routine_reason_locked
            "app_missing" -> R.string.routine_reason_app_missing
            "app_not_front" -> R.string.routine_reason_app_not_front
            "launch_confirm" -> R.string.routine_reason_launch_confirm
            "app_left" -> R.string.routine_reason_app_left
            "text_not_found" -> R.string.routine_reason_text_not_found
            "not_verified" -> R.string.routine_reason_not_verified
            "target_not_found" -> R.string.routine_reason_target_not_found
            "target_disabled" -> R.string.routine_reason_target_disabled
            "target_ambiguous" -> R.string.routine_reason_target_ambiguous
            "tap_refused" -> R.string.routine_reason_tap_refused
            "deadline" -> R.string.routine_reason_deadline
            else -> R.string.routine_reason_error
        },
    )

    // --- Editing ---

    private fun edit(existing: RoutineLogic.Routine?) {
        var packageName = existing?.packageName.orEmpty()
        var appLabel = existing?.appLabel.orEmpty()
        val steps = existing?.steps.orEmpty().toMutableList()

        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            setPadding(dp(20), dp(8), dp(20), dp(8))
        }
        val name = EditText(this).apply {
            hint = getString(R.string.routine_name_hint)
            setText(existing?.name.orEmpty())
            inputType = InputType.TYPE_CLASS_TEXT
            textDirection = View.TEXT_DIRECTION_ANY_RTL
        }
        form.addView(name)

        val appButton = Button(this).apply { isAllCaps = false }
        fun showApp() {
            appButton.text = if (packageName.isEmpty()) getString(R.string.routine_app_choose)
            else getString(R.string.routine_app_chosen, Ui.isolate(appLabel))
        }
        showApp()
        appButton.setOnClickListener {
            chooseApp { label, pkg ->
                appLabel = label
                packageName = pkg
                showApp()
            }
        }
        form.addView(appButton)

        form.addView(heading(getString(R.string.routine_steps_title), 16f))
        val stepList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun showSteps() {
            stepList.removeAllViews()
            steps.forEachIndexed { index, step ->
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                row.addView(TextView(this).apply {
                    text = "${index + 1}. ${describe(step)}"
                    textSize = 14f
                    textDirection = View.TEXT_DIRECTION_ANY_RTL
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(smallButton(getString(R.string.routine_step_remove)) {
                    steps.removeAt(index)
                    showSteps()
                })
                stepList.addView(row)
            }
        }
        showSteps()
        form.addView(stepList)
        form.addView(button(getString(R.string.routine_add_step)) {
            if (steps.size >= RoutineLogic.MAX_STEPS) return@button
            addStep { steps.add(it); showSteps() }
        })

        val dialog = AlertDialog.Builder(this)
            .setTitle(if (existing == null) R.string.routine_editor_new else R.string.routine_editor_edit)
            .setView(ScrollView(this).apply { addView(form) })
            .setPositiveButton(R.string.button_save, null)
            .setNegativeButton(R.string.chat_keep, null)
            .create()
        dialog.setOnShowListener {
            // Validate before closing: a bad routine keeps the dialog open.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val routine = RoutineLogic.Routine(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.text.toString().trim(),
                    packageName = packageName,
                    appLabel = appLabel,
                    steps = steps.toList(),
                )
                val problem = RoutineLogic.problem(routine)
                if (problem != null) {
                    AlertDialog.Builder(this).setMessage(problemText(problem))
                        .setPositiveButton(android.R.string.ok, null).show()
                    return@setOnClickListener
                }
                val save = {
                    RoutineStore.save(this, routine)
                    dialog.dismiss()
                    render()
                }
                if (routine.verifies) {
                    save()
                } else {
                    AlertDialog.Builder(this)
                        .setMessage(R.string.routine_save_without_verify)
                        .setPositiveButton(R.string.button_save) { _, _ -> save() }
                        .setNegativeButton(R.string.chat_keep, null)
                        .show()
                }
            }
        }
        dialog.show()
    }

    private fun addStep(add: (RoutineLogic.Step) -> Unit) {
        val kinds = listOfNotNull(
            RoutineLogic.Kind.TAP_TEXT to R.string.step_kind_tap_text,
            RoutineLogic.Kind.TYPE_TEXT to R.string.step_kind_type_text,
            // The keyboard's Enter needs Android 11; an older phone is not offered it.
            (RoutineLogic.Kind.SUBMIT to R.string.step_kind_submit).takeIf { Build.VERSION.SDK_INT >= Build.VERSION_CODES.R },
            RoutineLogic.Kind.WAIT_FOR_TEXT to R.string.step_kind_wait_for_text,
            RoutineLogic.Kind.EXPECT_DISABLED to R.string.step_kind_expect_disabled,
            RoutineLogic.Kind.EXPECT_TEXT to R.string.step_kind_expect_text,
            RoutineLogic.Kind.WAIT to R.string.step_kind_wait,
            RoutineLogic.Kind.TAP_ID to R.string.step_kind_tap_id,
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.step_kind_title)
            .setItems(kinds.map { getString(it.second) }.toTypedArray()) { _, which ->
                stepValues(kinds[which].first, add)
            }
            .show()
    }

    /** The text and the seconds of a new step, as its kind needs them. */
    private fun stepValues(kind: RoutineLogic.Kind, add: (RoutineLogic.Step) -> Unit) {
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(8))
        }
        val needsText = kind != RoutineLogic.Kind.WAIT && kind != RoutineLogic.Kind.SUBMIT
        val needsSeconds = kind == RoutineLogic.Kind.WAIT ||
            kind == RoutineLogic.Kind.WAIT_FOR_TEXT || kind == RoutineLogic.Kind.EXPECT_TEXT ||
            kind == RoutineLogic.Kind.EXPECT_DISABLED
        val text = EditText(this).apply {
            hint = getString(
                when (kind) {
                    RoutineLogic.Kind.TAP_ID -> R.string.step_hint_id
                    RoutineLogic.Kind.TYPE_TEXT -> R.string.step_hint_type
                    else -> R.string.step_hint_text
                },
            )
            inputType = InputType.TYPE_CLASS_TEXT
            textDirection = View.TEXT_DIRECTION_ANY_RTL
        }
        val seconds = EditText(this).apply {
            hint = getString(if (kind == RoutineLogic.Kind.WAIT) R.string.step_hint_pause else R.string.step_hint_seconds)
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        if (needsText) form.addView(text)
        if (needsSeconds) form.addView(seconds)
        // SUBMIT asks for nothing: no dialog, the step is added as it is.
        if (!needsText && !needsSeconds && kind != RoutineLogic.Kind.WAIT) {
            add(RoutineLogic.Step(kind, "", RoutineLogic.DEFAULT_SECONDS))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(kindLabel(kind))
            .setView(form)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val default = if (kind == RoutineLogic.Kind.WAIT) 2 else RoutineLogic.DEFAULT_SECONDS
                val step = RoutineLogic.Step(
                    kind = kind,
                    value = if (needsText) text.text.toString().trim() else "",
                    seconds = seconds.text.toString().toIntOrNull() ?: default,
                )
                val problem = RoutineLogic.stepProblem(step)
                if (problem == null) {
                    add(step)
                } else {
                    AlertDialog.Builder(this)
                        .setMessage(stepProblemText(problem))
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
            .setNegativeButton(R.string.chat_keep, null)
            .show()
    }

    private fun describe(step: RoutineLogic.Step): String = when (step.kind) {
        RoutineLogic.Kind.WAIT_FOR_TEXT -> getString(R.string.step_wait_for_text, quote(step.value), step.seconds)
        RoutineLogic.Kind.TAP_TEXT -> getString(R.string.step_tap_text, quote(step.value))
        RoutineLogic.Kind.TAP_ID -> getString(R.string.step_tap_id, Ui.isolate(step.value))
        RoutineLogic.Kind.EXPECT_TEXT -> getString(R.string.step_expect_text, quote(step.value), step.seconds)
        RoutineLogic.Kind.EXPECT_DISABLED -> getString(R.string.step_expect_disabled, quote(step.value), step.seconds)
        RoutineLogic.Kind.WAIT -> getString(R.string.step_wait, step.seconds)
        RoutineLogic.Kind.TYPE_TEXT -> getString(R.string.step_type_text, quote(step.value))
        RoutineLogic.Kind.SUBMIT -> getString(R.string.step_submit)
    }

    private fun quote(text: String) = Ui.isolate("\"$text\"")

    private fun kindLabel(kind: RoutineLogic.Kind) = getString(
        when (kind) {
            RoutineLogic.Kind.TAP_TEXT -> R.string.step_kind_tap_text
            RoutineLogic.Kind.WAIT_FOR_TEXT -> R.string.step_kind_wait_for_text
            RoutineLogic.Kind.EXPECT_TEXT -> R.string.step_kind_expect_text
            RoutineLogic.Kind.EXPECT_DISABLED -> R.string.step_kind_expect_disabled
            RoutineLogic.Kind.WAIT -> R.string.step_kind_wait
            RoutineLogic.Kind.TAP_ID -> R.string.step_kind_tap_id
            RoutineLogic.Kind.TYPE_TEXT -> R.string.step_kind_type_text
            RoutineLogic.Kind.SUBMIT -> R.string.step_kind_submit
        },
    )

    private fun stepProblemText(code: String): String = getString(
        when (code) {
            "id" -> R.string.step_problem_id
            "seconds" -> R.string.step_problem_seconds
            else -> R.string.step_problem_text
        },
    )

    private fun problemText(code: String): String = getString(
        when (code) {
            "name" -> R.string.routine_problem_name
            "app" -> R.string.routine_problem_app
            "steps" -> R.string.routine_problem_steps
            "no_tap" -> R.string.routine_problem_no_tap
            "expect_order" -> R.string.routine_problem_expect_order
            else -> R.string.routine_problem_step
        },
    )

    /** The installed apps with a launcher icon, by label; never this app. */
    private fun chooseApp(chosen: (String, String) -> Unit) {
        val pm = packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, 0)
            .filter { it.activityInfo.packageName != packageName }
            .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
        AlertDialog.Builder(this)
            .setTitle(R.string.routine_app_choose)
            .setItems(apps.map { it.first }.toTypedArray()) { _, which -> chosen(apps[which].first, apps[which].second) }
            .show()
    }

    private fun confirmDelete(routine: RoutineLogic.Routine) {
        AlertDialog.Builder(this)
            .setTitle(R.string.routine_delete_title)
            .setMessage(routine.name)
            .setPositiveButton(R.string.chat_delete) { _, _ ->
                RoutineStore.delete(this, routine.id)
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

    private fun smallButton(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        minWidth = 0
        minimumWidth = 0
        setPadding(dp(8), 0, dp(8), 0)
        setOnClickListener { onClick() }
    }

    private companion object {
        const val EXTRA_OUTCOME = "routine_outcome"
        const val EXTRA_STEP = "routine_step"
        const val EXTRA_REASON = "routine_reason"
        const val EXTRA_SCAN = "routine_scan"
        const val EXTRA_SCAN_OK = "routine_scan_ok"
    }
}
