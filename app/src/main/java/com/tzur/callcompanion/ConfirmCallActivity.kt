package com.tzur.callcompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The confirmation, on the phone's own screen (PLAN §6.17). It shows who and
 * the resolved number; "חיוג" places the call from this SIM, "ביטול" does not.
 * With several matching contacts it lists them and the tap chooses one.
 *
 * Expiry is checked again here: a request is never acted on after its two
 * minutes, however long the notification lingered.
 */
class ConfirmCallActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val request = CallRequest.from(intent) ?: return finish()
        if (request.isExpired()) {
            CallNotifier.dismiss(this, request.dispatchId)
            Toast.makeText(this, R.string.expired, Toast.LENGTH_LONG).show()
            return finish()
        }

        val dialIndex = intent?.getIntExtra(EXTRA_DIAL_INDEX, -1) ?: -1
        if (dialIndex in request.candidates.indices) return dial(request, dialIndex)

        render(request)
    }

    private fun render(request: CallRequest) {
        val pad = (24 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
        }

        val single = request.candidates.singleOrNull()
        root.addView(TextView(this).apply {
            text = if (single != null) getString(R.string.call_title, single.name) else getString(R.string.call_many_title)
            textSize = 26f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
        })

        request.candidates.forEachIndexed { index, candidate ->
            root.addView(Button(this).apply {
                text = if (single != null) {
                    "${getString(R.string.action_dial)}  ${CallNotifier.ltr(candidate.number)}"
                } else {
                    "${candidate.name}\n${CallNotifier.ltr(candidate.number)}"
                }
                textSize = 20f
                isAllCaps = false
                setOnClickListener { dial(request, index) }
            })
        }

        root.addView(Button(this).apply {
            text = getString(R.string.action_cancel)
            textSize = 18f
            setOnClickListener { cancel(request) }
        })

        setContentView(root)
    }

    private fun dial(request: CallRequest, index: Int) {
        if (request.isExpired()) {
            Toast.makeText(this, R.string.expired, Toast.LENGTH_LONG).show()
            CallNotifier.dismiss(this, request.dispatchId)
            return finish()
        }
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, R.string.no_call_permission, Toast.LENGTH_LONG).show()
            return
        }

        val number = request.candidates[index].number
        startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)))
        CallNotifier.dismiss(this, request.dispatchId)
        Reports.send(this, request.dispatchId, request.matched, "placed")
        finish()
    }

    private fun cancel(request: CallRequest) {
        CallNotifier.dismiss(this, request.dispatchId)
        Reports.send(this, request.dispatchId, request.matched, "cancelled")
        finish()
    }

    companion object {
        const val EXTRA_DIAL_INDEX = "dial_index"
    }
}
