package com.tzur.callcompanion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
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
 * phone's own lists, and the only links built are to Waze, Maps and WhatsApp.
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
        val candidates = ContactMatcher.match(queries, ContactsReader.read(activity))

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

        when (candidates.size) {
            0 -> {
                toast(activity, R.string.card_no_contact)
                done("no_match")
            }
            1 -> open(candidates[0])
            // Names are shown only here, on this phone; nothing about them is reported.
            else -> choose(activity, R.string.card_choose_contact, candidates.map { it.name }, { open(candidates[it]) }, { done("failed") })
        }
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
}
