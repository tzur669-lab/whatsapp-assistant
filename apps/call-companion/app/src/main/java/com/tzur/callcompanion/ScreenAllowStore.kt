package com.tzur.callcompanion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The apps the screen agent may act in (0.14), chosen on this phone only:
 * package, label and "ask before every tap", at most [ScreenLogic.MAX_APPS].
 * Private preferences, excluded from backup. Every change is synced to the
 * server whole (`/app/screen/allow`), and removing an app stops a task
 * running in it at once.
 */
object ScreenAllowStore {
    private const val PREFS = "screen_allow"
    private const val KEY = "apps"

    fun all(context: Context): List<ScreenLogic.AllowedApp> {
        val raw = prefs(context).getString(KEY, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { i ->
                val o = array.getJSONObject(i)
                val app = ScreenLogic.AllowedApp(o.optString("package"), o.optString("label"), o.optBoolean("askEveryTap", false))
                app.takeIf { ScreenLogic.validPackage(it.packageName) }
            }.distinctBy { it.packageName }.take(ScreenLogic.MAX_APPS)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun get(context: Context, packageName: String): ScreenLogic.AllowedApp? =
        all(context).firstOrNull { it.packageName == packageName }

    /** Adds at the end, or replaces in place. False when the list is full or the app may never be listed. */
    fun put(context: Context, app: ScreenLogic.AllowedApp): Boolean {
        val current = all(context)
        if (!ScreenLogic.validPackage(app.packageName) || ScreenLogic.blocked(app.packageName, context.packageName)) return false
        val list = if (current.any { it.packageName == app.packageName }) {
            current.map { if (it.packageName == app.packageName) app else it }
        } else {
            if (current.size >= ScreenLogic.MAX_APPS) return false
            current + app
        }
        write(context, list)
        return true
    }

    fun remove(context: Context, packageName: String) {
        write(context, all(context).filter { it.packageName != packageName })
        // A task running in it stops now, not at its next step.
        ScreenAgentRunner.stopPackage(packageName)
    }

    private fun write(context: Context, list: List<ScreenLogic.AllowedApp>) {
        val array = JSONArray()
        list.forEach {
            array.put(JSONObject().put("package", it.packageName).put("label", it.label).put("askEveryTap", it.askEveryTap))
        }
        prefs(context).edit().putString(KEY, array.toString()).commit()
        RoutineAccessibilityService.refreshPackages(context)
        ScreenAgentRunner.syncAllow(context)
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
