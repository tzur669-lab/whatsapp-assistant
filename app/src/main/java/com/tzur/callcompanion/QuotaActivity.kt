package com.tzur.callcompanion

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Quotas (0.6): for each Groq model, the day's requests and the minute's
 * tokens as Groq last reported them, and the day's tokens as the server counts
 * them; recordings in the last hour; and the server's requests today.
 *
 * Each line says which kind of number it is. Groq's own are exact as of the
 * last call to that model. The server's counts miss what was spent on the
 * same key elsewhere — an eval run from a laptop, above all.
 */
class QuotaActivity : Activity() {
    private lateinit var content: LinearLayout
    private lateinit var refreshButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
    }

    override fun onResume() {
        super.onResume()
        load()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildLayout(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }
        column.addView(text("מכסות", 24f, bold = true))
        column.addView(text("מדויק: מה ש־Groq מדווח, נכון לקריאה האחרונה למודל. מקורב: מה שהשרת סופר בעצמו.", 13f, color = META))
        refreshButton = Button(this).apply {
            text = "רענון"
            isAllCaps = false
            setOnClickListener { load() }
        }
        column.addView(refreshButton)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(content)

        val scroll = ScrollView(this).apply { addView(column) }
        Ui.fitSystemBars(scroll)
        return scroll
    }

    private fun load() {
        refreshButton.isEnabled = false
        content.removeAllViews()
        content.addView(text("טוען…", 15f))
        val app = applicationContext
        Thread {
            val report = Api.fetchQuota(app)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                refreshButton.isEnabled = true
                show(report)
            }
        }.start()
    }

    private fun show(report: QuotaLogic.Report?) {
        content.removeAllViews()
        if (report == null) {
            content.addView(text("לא ניתן היה לקבל את הנתונים מהשרת. אפשר לנסות שוב ברענון.", 15f))
            return
        }
        val at = report.at

        for (model in report.models) {
            val card = card(QuotaLogic.roleLabel(model.role), model.model)
            val requests = model.requests
            val minute = model.minuteTokens
            if (requests == null && minute == null) {
                card.addView(text("עוד אין נתונים מ־Groq. הם יופיעו אחרי הקריאה הראשונה למודל.", 14f, color = META))
            }
            if (requests != null) {
                bar(
                    card,
                    "בקשות היום",
                    requests.limit - requests.remaining,
                    requests.limit,
                    "${QuotaLogic.resetsIn(requests.resetAt, at)} · מדויק, ${QuotaLogic.age(requests.observedAt, at)}",
                )
            }
            if (minute != null) {
                bar(
                    card,
                    "טוקנים בדקה",
                    minute.limit - minute.remaining,
                    minute.limit,
                    "${QuotaLogic.resetsIn(minute.resetAt, at)} · מדויק, ${QuotaLogic.age(minute.observedAt, at)}",
                )
            }
            model.dayTokens?.let {
                bar(card, "טוקנים ב־24 השעות האחרונות", it.used, it.limit, "מקורב: נספר בשרת, לא כולל שימוש מחוץ לו (למשל evals)")
            }
            content.addView(card)
        }

        val voice = card("הקלטות", null)
        bar(voice, "בשעה האחרונה", report.voice.used, report.voice.limit, "מדויק: התקרה של השרת")
        content.addView(voice)

        val worker = card("שרת (Cloudflare)", null)
        bar(
            worker,
            "בקשות היום",
            report.workerRequests.used,
            report.workerRequests.limit,
            "${QuotaLogic.resetsIn(report.workerResetAt, at)} · מקורב: ספירה של השרת",
        )
        content.addView(worker)

        content.addView(text("נכון ל־${Ui.isolate(SimpleDateFormat("HH:mm", Locale.ROOT).format(Date(at)))}", 12f, color = META))
    }

    private fun card(title: String, subtitle: String?): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(14), dp(10), dp(14), dp(12))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(CARD)
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(12) }
        addView(text(title, 18f, bold = true))
        if (subtitle != null) addView(text(Ui.isolate(subtitle), 12f, color = META))
    }

    private fun bar(card: LinearLayout, label: String, used: Long, limit: Long, note: String) {
        card.addView(text("$label: ${Ui.isolate(QuotaLogic.usedOf(limit, used))}", 15f).apply { setPadding(0, dp(10), 0, dp(2)) })
        card.addView(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progress = (QuotaLogic.fraction(used, limit) * 1000).toInt()
            progressTintList = ColorStateList.valueOf(
                when (QuotaLogic.level(used, limit)) {
                    QuotaLogic.FULL -> RED
                    QuotaLogic.WARN -> AMBER
                    else -> GREEN
                },
            )
        })
        card.addView(text(note, 12f, color = META))
    }

    private fun text(value: String, size: Float, bold: Boolean = false, color: Int = TEXT) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textDirection = View.TEXT_DIRECTION_ANY_RTL
    }

    private companion object {
        val TEXT = Color.rgb(0x11, 0x1B, 0x21)
        val META = Color.rgb(0x66, 0x77, 0x81)
        val CARD = Color.rgb(0xF1, 0xF3, 0xF4)
        val GREEN = Color.rgb(0x2E, 0x7D, 0x32)
        val AMBER = Color.rgb(0xF9, 0xA8, 0x25)
        val RED = Color.rgb(0xC6, 0x28, 0x28)
    }
}
