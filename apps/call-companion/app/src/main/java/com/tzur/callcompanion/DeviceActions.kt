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
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.provider.AlarmClock
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
                "file" -> saveFile(activity, action, done)
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
     * A video or a song (0.8.2): the app's own search opens with the words, and
     * playing is a tap on the result.
     *
     * Measured on the phone (2026-10-05): YouTube and YouTube Music both accept
     * MEDIA_PLAY_FROM_SEARCH and then ignore it — the home screen opens and
     * nothing plays, which looked like "it opens nothing". YouTube takes
     * ACTION_SEARCH; YouTube Music takes only its own search link.
     *
     * Background: the results stay up so the tap can be made; the toast says to
     * come back after it. Android keeps it playing only for YouTube Premium.
     */
    private fun media(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val app = a.getString("app").also { require(it == "youtube" || it == "youtube_music") }
        val mode = a.getString("mode").also { require(it == "background" || it == "fullscreen") }
        val query = a.getString("query").also { require(it.isNotBlank() && it.length <= 100) }
        val music = app == "youtube_music"
        val pkg = if (music) YOUTUBE_MUSIC else YOUTUBE

        val link = Uri.parse(
            if (music) "https://music.youtube.com/search?q=${Uri.encode(query)}"
            else "https://www.youtube.com/results?search_query=${Uri.encode(query)}",
        )
        val inApp = if (music) {
            Intent(Intent.ACTION_VIEW, link).setPackage(pkg)
        } else {
            Intent(Intent.ACTION_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, query)
        }
        val web = Intent(Intent.ACTION_VIEW, link)
        val started = listOf(inApp, web).any { intent ->
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

        toast(activity, if (mode == "background") R.string.card_media_background else R.string.card_media_tap)
        done("done")
    }

    /**
     * Save the file to Downloads and open it (2026-10-05, the expenses export).
     * MediaStore needs no permission on Android 10 and later; earlier versions
     * are told the phone does not support it rather than asked for storage.
     */
    private fun saveFile(activity: Activity, a: JSONObject, done: (String) -> Unit) {
        val file = CardLogic.fileCard(
            a.optString("type"),
            a.optString("name").ifEmpty { null },
            a.optString("mime").ifEmpty { null },
            a.optString("content").ifEmpty { null },
        ) ?: return done("failed")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            toast(activity, R.string.card_not_supported)
            return done("unsupported")
        }

        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, file.name)
            put(MediaStore.Downloads.MIME_TYPE, "text/csv")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return done("failed")
        try {
            resolver.openOutputStream(uri)?.use { it.write(file.content.toByteArray(Charsets.UTF_8)) }
                ?: throw IllegalStateException("no stream")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }

        val open = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "text/csv")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(open)
        } catch (_: ActivityNotFoundException) {
            // Saved all the same; there is just nothing here that opens a CSV.
        }
        toast(activity, R.string.card_file_saved)
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
}
