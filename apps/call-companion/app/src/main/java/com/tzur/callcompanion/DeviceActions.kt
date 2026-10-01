package com.tzur.callcompanion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import android.provider.MediaStore
import android.provider.Settings
import android.widget.Toast
import org.json.JSONObject

/**
 * Runs a claimed card on this phone (PLAN §6.20).
 *
 * What arrives is the server's validated input, and it is validated again here:
 * a closed list of types, every field bounded. Nothing in it can name a number,
 * a package or a URL — a contact and an app are words matched against this
 * phone's own lists, and the only links built are to Waze, Maps, WhatsApp and
 * YouTube's own search.
 *
 * Main thread. [done] gets the outcome to report: done | failed | no_match |
 * unsupported. Never what was matched.
 */
object DeviceActions {
    fun run(activity: Activity, action: JSONObject, done: (String) -> Unit) {
        try {
            when (action.optString("type")) {
                "alarm" -> alarm(activity, action, done)
                "timer" -> timer(activity, action, done)
                "nav" -> nav(activity, action, done)
                "app" -> openApp(activity, action, done)
                "settings" -> settings(activity, action, done)
                "message" -> message(activity, action, done)
                "media" -> media(activity, action, done)
                else -> done("unsupported")
            }
        } catch (_: ActivityNotFoundException) {
            toast(activity, R.string.card_not_supported)
            done("unsupported")
        } catch (_: SecurityException) {
            toast(activity, R.string.card_failed)
            done("failed")
        } catch (_: Exception) {
            toast(activity, R.string.card_failed)
            done("failed")
        }
    }

    // -- one per type -----------------------------------------------------------

    private fun alarm(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val hour = a.getInt("hour").also { require(it in 0..23) }
        val minute = a.getInt("minute").also { require(it in 0..59) }
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        label(a)?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        activity.startActivity(intent)
        done("done")
    }

    private fun timer(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val seconds = a.getInt("seconds").also { require(it in 60..86_400) }
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        label(a)?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        activity.startActivity(intent)
        done("done")
    }

    private fun nav(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val app = a.getString("app").also { require(it == "waze" || it == "maps") }
        val favorite = a.optString("favorite").takeIf { it == "home" || it == "work" }
        val destination = a.optString("destination").takeIf { it.isNotBlank() && it.length <= 100 }
        require((favorite == null) != (destination == null))

        val waze = when {
            favorite != null -> "waze://?favorite=$favorite&navigate=yes"
            else -> "https://waze.com/ul?q=${Uri.encode(destination)}&navigate=yes"
        }
        val maps = "google.navigation:q=${Uri.encode(favorite ?: destination)}"

        val first = if (app == "waze") waze else maps
        val second = if (app == "waze") maps else waze
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(first)))
        } catch (_: ActivityNotFoundException) {
            // The other navigator, rather than nothing.
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(second)))
        }
        done("done")
    }

    private fun openApp(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val queries = strings(a, "queries")
        val pm = activity.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val installed = pm.queryIntentActivities(launcher, 0)
            .filter { it.activityInfo.packageName != activity.packageName }
            .map { CardLogic.App(it.loadLabel(pm).toString(), it.activityInfo.packageName) }

        val matches = CardLogic.matchApps(queries, installed)
        val launch = { chosen: CardLogic.App ->
            val intent = pm.getLaunchIntentForPackage(chosen.packageName)
            if (intent == null) {
                done("failed")
            } else {
                activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                done("done")
            }
        }
        when (matches.size) {
            0 -> {
                toast(activity, R.string.card_no_app)
                done("no_match")
            }
            1 -> launch(matches[0])
            else -> choose(activity, R.string.card_choose_app, matches.map { it.label }, { launch(matches[it]) }, { done("failed") })
        }
    }

    private fun settings(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val state = a.optString("state")
        when (a.getString("setting")) {
            "flashlight" -> {
                val camera = activity.getSystemService(CameraManager::class.java)
                val id = camera.cameraIdList.firstOrNull {
                    camera.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                }
                if (id == null) {
                    toast(activity, R.string.card_no_flash)
                    return done("unsupported")
                }
                camera.setTorchMode(id, state != "off")
                done("done")
            }
            "dnd" -> {
                val manager = activity.getSystemService(NotificationManager::class.java)
                if (!manager.isNotificationPolicyAccessGranted) return askForPolicyAccess(activity, done)
                manager.setInterruptionFilter(
                    if (state == "off") NotificationManager.INTERRUPTION_FILTER_ALL else NotificationManager.INTERRUPTION_FILTER_PRIORITY,
                )
                done("done")
            }
            "ringer" -> {
                val manager = activity.getSystemService(NotificationManager::class.java)
                if (!manager.isNotificationPolicyAccessGranted) return askForPolicyAccess(activity, done)
                val audio = activity.getSystemService(AudioManager::class.java)
                audio.ringerMode = when (state) {
                    "silent" -> AudioManager.RINGER_MODE_SILENT
                    "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
                    "normal" -> AudioManager.RINGER_MODE_NORMAL
                    else -> return done("unsupported")
                }
                done("done")
            }
            // Android lets no app flip these radios; it offers the panel instead.
            "wifi" -> {
                activity.startActivity(
                    Intent(if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_WIFI else Settings.ACTION_WIFI_SETTINGS),
                )
                done("done")
            }
            "bluetooth" -> {
                activity.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                done("done")
            }
            else -> done("unsupported")
        }
    }

    /**
     * A message, opened ready in the SMS app or WhatsApp. Sending it is the
     * user's own tap there: this app never sends anything to anyone.
     */
    private fun message(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val channel = a.getString("channel").also { require(it == "sms" || it == "whatsapp") }
        val text = a.getString("text").also { require(it.isNotBlank() && it.length <= 500) }
        val queries = strings(a, "queries")

        if (activity.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            toast(activity, R.string.card_no_contacts_permission)
            return done("failed")
        }
        val match = ContactMatcher.match(queries, ContactsReader.read(activity))
        val candidates = match.candidates

        val open = { chosen: Candidate ->
            if (channel == "sms") {
                activity.startActivity(
                    Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(chosen.number))).putExtra("sms_body", text),
                )
                done("done")
            } else {
                val number = CardLogic.whatsAppNumber(chosen.number)
                if (number == null) {
                    toast(activity, R.string.card_failed)
                    done("failed")
                } else {
                    val uri = Uri.parse("https://wa.me/$number?text=${Uri.encode(text)}")
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.whatsapp"))
                    } catch (_: ActivityNotFoundException) {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    }
                    done("done")
                }
            }
        }

        when {
            candidates.isEmpty() -> {
                toast(activity, R.string.card_no_contact)
                done("no_match")
            }
            // Only a contact the words fully named opens without a choice.
            candidates.size == 1 && !match.partial -> open(candidates[0])
            // Names are shown only here, on this phone; nothing about them is reported.
            else -> choose(
                activity,
                if (match.partial) R.string.card_partial_contact else R.string.card_choose_contact,
                candidates.map { it.name },
                { open(candidates[it]) },
                { done("failed") },
            )
        }
    }

    /**
     * A video or a song (0.8.1): YouTube or YouTube Music plays its best match
     * for the words, the way Google Assistant asks it to. Where the app does not
     * take that, its search opens with the words, and the choice is a tap there.
     *
     * Background: the player starts, and this app comes back in front of it a
     * moment later. Android keeps it playing only for YouTube Premium; without
     * it, the app pauses — which the toast says.
     */
    private fun media(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val app = a.getString("app").also { require(it == "youtube" || it == "youtube_music") }
        val mode = a.getString("mode").also { require(it == "background" || it == "fullscreen") }
        val query = a.getString("query").also { require(it.isNotBlank() && it.length <= 100) }
        val music = app == "youtube_music"
        val pkg = if (music) YOUTUBE_MUSIC else YOUTUBE

        val play = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .setPackage(pkg)
            .putExtra(SearchManager.QUERY, query)
            .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
        val search = Intent(Intent.ACTION_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, query)
        val web = Intent(
            Intent.ACTION_VIEW,
            Uri.parse(
                if (music) "https://music.youtube.com/search?q=${Uri.encode(query)}"
                else "https://www.youtube.com/results?search_query=${Uri.encode(query)}",
            ),
        )
        val started = listOf(play, search, web).any { intent ->
            try {
                activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: ActivityNotFoundException) {
                false
            }
        }
        if (!started) {
            toast(activity, R.string.card_no_app)
            return done("no_match")
        }

        if (mode == "background") {
            toast(activity, R.string.card_media_background)
            val context = activity.applicationContext
            val back = Intent(context, activity.javaClass)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_NEW_TASK)
            Handler(Looper.getMainLooper()).postDelayed({
                // Within Android's grace for an app that was just in front; past it, the player stays up.
                runCatching { context.startActivity(back) }
            }, BACKGROUND_RETURN_MS)
        }
        done("done")
    }

    // -- helpers ----------------------------------------------------------------

    private fun askForPolicyAccess(activity: Activity, done: (String) -> Unit) {
        toast(activity, R.string.card_need_dnd_access)
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
        done("failed")
    }

    private fun choose(activity: Activity, title: Int, labels: List<String>, pick: (Int) -> Unit, cancelled: () -> Unit) {
        var picked = false
        AlertDialog.Builder(activity)
            .setTitle(title)
            .setItems(labels.take(MAX_CHOICES).toTypedArray()) { _, which ->
                picked = true
                pick(which)
            }
            .setOnDismissListener { if (!picked) cancelled() }
            .show()
    }

    private fun label(a: JSONObject): String? = a.optString("label").takeIf { it.isNotBlank() && it.length <= 60 }

    private fun strings(a: JSONObject, key: String): List<String> {
        val array = a.getJSONArray(key)
        require(array.length() in 1..5)
        return List(array.length()) { array.getString(it).also { s -> require(s.isNotBlank() && s.length <= 100) } }
    }

    private fun toast(activity: Activity, text: Int) = Toast.makeText(activity, text, Toast.LENGTH_LONG).show()

    private const val MAX_CHOICES = 10
    private const val YOUTUBE = "com.google.android.youtube"
    private const val YOUTUBE_MUSIC = "com.google.android.apps.youtube.music"
    /** Long enough for the player to start, well inside Android's ten-second grace. */
    private const val BACKGROUND_RETURN_MS = 3_000L
}
