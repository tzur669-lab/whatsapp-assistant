package com.tzur.callcompanion

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The home-screen widget (0.11, ROADMAP #22): the newest reminder, and two
 * buttons into the chat — to type, or to talk. Talking still takes a tap on
 * 🎤 in the chat: nothing outside the app can start a recording.
 *
 * Its line is kept in its own preferences, written when [Sync] stores rows,
 * so drawing it reads no database.
 */
class AssistantWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        draw(context, manager, ids)
    }

    companion object {
        private const val PREFS = "widget"
        private const val KEY_TEXT = "text"
        private const val KEY_AT = "at"
        private const val KEY_PRIVATE = "private"

        /** Keep the newest reminder among [rows], and redraw when it changed. */
        fun record(context: Context, rows: List<Row>) {
            val line = WidgetLogic.latest(rows) ?: return
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!WidgetLogic.replaces(line, prefs.getLong(KEY_AT, 0L))) return
            prefs.edit()
                .putString(KEY_TEXT, line.text)
                .putBoolean(KEY_PRIVATE, line.text == null)
                .putLong(KEY_AT, line.at)
                .apply()
            refresh(context)
        }

        /** The phone was unpaired: nothing it showed should stay on the home screen. */
        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
            refresh(context)
        }

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(context, AssistantWidget::class.java))
            if (ids.isNotEmpty()) draw(context, manager, ids)
        }

        private fun draw(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val at = prefs.getLong(KEY_AT, 0L)
            val text = prefs.getString(KEY_TEXT, null)
            val views = RemoteViews(context.packageName, R.layout.widget)

            val line = when {
                at == 0L -> context.getString(R.string.widget_no_reminders)
                prefs.getBoolean(KEY_PRIVATE, false) || text == null -> context.getString(R.string.widget_private_reminder)
                else -> text
            }
            views.setTextViewText(R.id.widget_line, line)
            if (at > 0L) {
                val time = SimpleDateFormat("d.M · HH:mm", Locale.ROOT).format(Date(at))
                views.setTextViewText(R.id.widget_time, Ui.isolate(time))
                views.setViewVisibility(R.id.widget_time, View.VISIBLE)
            } else {
                views.setViewVisibility(R.id.widget_time, View.GONE)
            }

            views.setOnClickPendingIntent(R.id.widget_line, open(context, ChatActivity.START_REMINDERS, 1))
            views.setOnClickPendingIntent(R.id.widget_type, open(context, ChatActivity.START_TYPE, 2))
            views.setOnClickPendingIntent(R.id.widget_talk, open(context, ChatActivity.START_VOICE, 3))
            manager.updateAppWidget(ids, views)
        }

        private fun open(context: Context, start: String, requestCode: Int): PendingIntent =
            PendingIntent.getActivity(
                context,
                requestCode,
                Intent(context, ChatActivity::class.java)
                    .putExtra(ChatActivity.EXTRA_START, start)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
    }
}
