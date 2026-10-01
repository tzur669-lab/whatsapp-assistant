package com.tzur.callcompanion

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * How to use the app, and every command with what it does (0.5). Opened from
 * the settings screen and from the chat's menu. The commands come from
 * [ChatLogic.COMMANDS], the same list `/` offers in the chat, so the two
 * cannot disagree.
 */
class GuideActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        setContentView(buildLayout())
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildLayout(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }

        column.addView(heading("מדריך לשימוש", 24f))
        for ((title, body) in SECTIONS) {
            column.addView(heading(title, 18f))
            column.addView(paragraph(body))
        }

        column.addView(heading("פקודות", 22f))
        column.addView(paragraph("פקודה מתחילה ב־/. בצ׳אט, הקלדת / פותחת את הרשימה הזאת, ונגיעה בפקודה מכניסה אותה לשדה."))
        for (command in ChatLogic.COMMANDS) column.addView(commandRow(command))

        val scroll = ScrollView(this).apply { addView(column) }
        Ui.fitSystemBars(scroll)
        return scroll
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
    }

    private fun commandRow(command: ChatLogic.Command): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.rgb(0xF1, 0xF3, 0xF4))
            }
        }
        box.addView(TextView(this).apply {
            // The command reads left to right inside the Hebrew page.
            text = Ui.isolate(command.usage)
            textSize = 16f
            setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        })
        box.addView(TextView(this).apply {
            text = command.description
            textSize = 14f
        })
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(4))
            addView(box)
        }
    }

    private companion object {
        val SECTIONS = listOf(
            "מה העוזר יודע לעשות" to
                "• תזכורות — \"תזכיר לי מחר ב־8 להתקשר לאבא\"\n" +
                "• רשימת תזכורות — \"מה התזכורות שלי\"\n" +
                "• יומן — \"מה יש לי ביומן מחר\", \"אילו פגישות היו לי השבוע\"\n" +
                "• פגישה — \"תקבע פגישה עם יוסי מחר ב־14:00 לשעה\"\n" +
                "• שיחה — \"תתקשר לדני כהן\"\n" +
                "• הודעה — \"תשלח לדנה ב־WhatsApp שאני מאחר\" (נפתחת מוכנה, השליחה שלך)\n" +
                "• שעון מעורר, טיימר, ניווט ופתיחת אפליקציות\n" +
                "• שאלות ושיחה חופשית",
            "שיחות" to
                "כמו באפליקציית צ׳אט: ☰ פותח את רשימת השיחות, ＋ מתחיל שיחה חדשה. כל שיחה נשמרת בטלפון " +
                "ומופיעה ברשימה לפי השימוש האחרון. לחיצה ארוכה על שיחה ברשימה מוחקת אותה.\n\n" +
                "בכל שיחה העוזר זוכר את 6 ההודעות האחרונות, עד 12 שעות (שעה אחת אחרי שהוא קרא יומן או " +
                "הודעות של אחרים). ההודעות הישנות נשארות על המסך גם אחרי שהוא כבר לא זוכר אותן. " +
                "/forget מוחק את הזיכרון שלו מכל השיחות.",
            "תזכורות" to
                "תזכורות, התקציר היומי וימי הולדת מגיעים לשיחה הקבועה 🔔 תזכורות שבראש התפריט, " +
                "וגם כהתראה. הכפתורים שמתחתיהם (נדנוד, בוצע) עובדים משם ומההתראה.",
            "הקלטה" to
                "להחזיק את 🎤 ולדבר, לשחרר כדי לשלוח (עד דקה). התשובה מתחילה במה שהעוזר שמע, " +
                "כדי שאפשר יהיה לראות שהוא הבין נכון. ההקלטה לא נשמרת.",
            "אישורים" to
                "פעולות שמשנות משהו — מחיקה, פגישה עם משתתפים, פעולה אחרי קריאת יומן — מחכות לאישור: " +
                "הכפתורים ✅ אישור / ❌ ביטול, או לכתוב \"אישור\" או \"כן\". שיחה טלפונית מאושרת במסך " +
                "של הטלפון, שמציג את השם והמספר. כשכמה אנשי קשר מתאימים, או שנמצא רק חלק מהשם, " +
                "מופיעה רשימה ובוחרים ממנה.",
            "העתקה" to
                "לחיצה ארוכה על הודעה — שלך או של העוזר — מעתיקה אותה.",
            "מכסות" to
                "📊 מכסות (בתפריט ☰ ובהגדרות) מציג כמה נוצל מכל מכסה: בקשות וטוקנים של Groq לכל מודל, " +
                "הקלטות בשעה האחרונה ובקשות לשרת היום. ליד כל מספר כתוב אם הוא מדויק — כפי ש־Groq מדווח, " +
                "נכון לקריאה האחרונה — או מקורב, כלומר נספר בשרת ולא כולל שימוש מחוץ לו, כמו הרצת evals מהמחשב.",
        )
    }
}
