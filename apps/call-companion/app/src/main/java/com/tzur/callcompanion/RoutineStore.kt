package com.tzur.callcompanion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The saved routines (0.13). A few small records, kept in the app's private
 * preferences, which are excluded from backup (`data_extraction_rules.xml`).
 * Nothing here is sent anywhere yet; stage 2 will sync names and hashes only.
 */
object RoutineStore {
    private const val PREFS = "routines"
    private const val KEY = "list"

    fun all(context: Context): List<RoutineLogic.Routine> {
        val raw = prefs(context).getString(KEY, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { read(array.getJSONObject(it)) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun get(context: Context, id: String): RoutineLogic.Routine? = all(context).firstOrNull { it.id == id }

    /** Adds or replaces by id. The caller has checked [RoutineLogic.problem]. */
    fun save(context: Context, routine: RoutineLogic.Routine) {
        val list = all(context).filter { it.id != routine.id } + routine
        write(context, list)
    }

    fun delete(context: Context, id: String) {
        write(context, all(context).filter { it.id != id })
    }

    private fun write(context: Context, list: List<RoutineLogic.Routine>) {
        val array = JSONArray()
        list.forEach { array.put(json(it)) }
        prefs(context).edit().putString(KEY, array.toString()).apply()
        // The service listens only to the apps the routines use.
        RoutineAccessibilityService.refreshPackages(context)
    }

    private fun json(routine: RoutineLogic.Routine): JSONObject = JSONObject()
        .put("id", routine.id)
        .put("name", routine.name)
        .put("package", routine.packageName)
        .put("label", routine.appLabel)
        .put("steps", JSONArray().apply {
            routine.steps.forEach { step ->
                put(JSONObject().put("kind", step.kind.name).put("value", step.value).put("seconds", step.seconds))
            }
        })

    /** A stored record read back; anything that no longer validates is dropped, not run. */
    private fun read(o: JSONObject): RoutineLogic.Routine? {
        val steps = o.optJSONArray("steps") ?: return null
        val parsed = (0 until steps.length()).map { i ->
            val s = steps.getJSONObject(i)
            val kind = RoutineLogic.Kind.entries.firstOrNull { it.name == s.optString("kind") } ?: return null
            RoutineLogic.Step(kind, s.optString("value"), s.optInt("seconds", RoutineLogic.DEFAULT_SECONDS))
        }
        val routine = RoutineLogic.Routine(
            id = o.optString("id"),
            name = o.optString("name"),
            packageName = o.optString("package"),
            appLabel = o.optString("label"),
            steps = parsed,
        )
        return routine.takeIf { it.id.isNotEmpty() && RoutineLogic.problem(it) == null }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
