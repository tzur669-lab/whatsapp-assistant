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
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
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
        for (routine in routines) column.addView(routineRow(routine))
        column.addView(button(getString(R.string.routines_new)) { edit(null) })
    }

    private fun routineRow(routine: RoutineLogic.Routine): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.rgb(0xF1, 0xF3, 0xF4))
            }
        }
        box.addView(TextView(this).apply {
            text = routine.name
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            textDirection = View.TEXT_DIRECTION_ANY_RTL
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
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(smallButton(getString(R.string.routine_dry)) { run(routine, dryRun = true) })
        actions.addView(smallButton(getString(R.string.routine_run)) { confirmRun(routine) })
        actions.addView(smallButton(getString(R.string.routine_edit)) { edit(routine) })
        actions.addView(smallButton(getString(R.string.routine_delete)) { confirmDelete(routine) })
        box.addView(actions)
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

    private fun showResult(intent: Intent?) {
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
            "app_left" -> R.string.routine_reason_app_left
            "text_not_found" -> R.string.routine_reason_text_not_found
            "not_verified" -> R.string.routine_reason_not_verified
            "target_not_found" -> R.string.routine_reason_target_not_found
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
        val kinds = listOf(
            RoutineLogic.Kind.TAP_TEXT to R.string.step_kind_tap_text,
            RoutineLogic.Kind.WAIT_FOR_TEXT to R.string.step_kind_wait_for_text,
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
        val needsText = kind != RoutineLogic.Kind.WAIT
        val needsSeconds = kind == RoutineLogic.Kind.WAIT ||
            kind == RoutineLogic.Kind.WAIT_FOR_TEXT || kind == RoutineLogic.Kind.EXPECT_TEXT
        val text = EditText(this).apply {
            hint = getString(if (kind == RoutineLogic.Kind.TAP_ID) R.string.step_hint_id else R.string.step_hint_text)
            inputType = InputType.TYPE_CLASS_TEXT
            textDirection = View.TEXT_DIRECTION_ANY_RTL
        }
        val seconds = EditText(this).apply {
            hint = getString(if (kind == RoutineLogic.Kind.WAIT) R.string.step_hint_pause else R.string.step_hint_seconds)
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        if (needsText) form.addView(text)
        if (needsSeconds) form.addView(seconds)
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
        RoutineLogic.Kind.WAIT -> getString(R.string.step_wait, step.seconds)
    }

    private fun quote(text: String) = Ui.isolate("\"$text\"")

    private fun kindLabel(kind: RoutineLogic.Kind) = getString(
        when (kind) {
            RoutineLogic.Kind.TAP_TEXT -> R.string.step_kind_tap_text
            RoutineLogic.Kind.WAIT_FOR_TEXT -> R.string.step_kind_wait_for_text
            RoutineLogic.Kind.EXPECT_TEXT -> R.string.step_kind_expect_text
            RoutineLogic.Kind.WAIT -> R.string.step_kind_wait
            RoutineLogic.Kind.TAP_ID -> R.string.step_kind_tap_id
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
    }
}
