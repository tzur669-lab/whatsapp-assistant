package com.tzur.callcompanion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/**
 * Answer the assistant's phone read (PLAN §6.21), on the Turns thread.
 *
 * Each read checks its own permission and answers `denied` without it — the
 * server then says, in its own words, where to grant it. What goes back is the
 * minimum [PhoneReadLogic] allows: names, not numbers; no one-time codes; each
 * field capped. Nothing is written down here.
 */
object PhoneReads {
    private const val HOUR_MS = 60 * 60 * 1000L
    /** Read at most this many SMS rows to find the twenty that match. */
    private const val SMS_SCAN = 200

    fun run(context: Context, query: JSONObject?): JSONObject {
        val parsed = queryOf(query) ?: return refused("unsupported")
        return try {
            when (parsed) {
                is PhoneReadLogic.Query.Contacts -> contacts(context, parsed)
                is PhoneReadLogic.Query.Notifications -> notifications(context, parsed)
                is PhoneReadLogic.Query.Sms -> sms(context, parsed)
            }
        } catch (_: SecurityException) {
            refused("denied")
        }
    }

    private fun contacts(context: Context, query: PhoneReadLogic.Query.Contacts): JSONObject {
        if (!granted(context, Manifest.permission.READ_CONTACTS)) return refused("denied")
        val names = mutableListOf<String>()
        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) cursor.getString(0)?.let { names += it }
        }
        return ok(PhoneReadLogic.contactNames(query.queries, names).map { PhoneReadLogic.Item(name = it) })
    }

    private fun notifications(context: Context, query: PhoneReadLogic.Query.Notifications): JSONObject {
        if (!NotificationBuffer.isEnabled(context)) return refused("denied")
        val since = System.currentTimeMillis() - query.hours * HOUR_MS
        val items = NotificationBuffer.get(context).since(since, query.app).map {
            PhoneReadLogic.Item(app = it.app, title = it.title, text = it.text, at = it.postedAt)
        }
        return ok(items)
    }

    private fun sms(context: Context, query: PhoneReadLogic.Query.Sms): JSONObject {
        if (!granted(context, Manifest.permission.READ_SMS)) return refused("denied")
        val since = System.currentTimeMillis() - query.hours * HOUR_MS
        val unknown = context.getString(R.string.read_unknown_sender)
        val canName = granted(context, Manifest.permission.READ_CONTACTS)
        val names = HashMap<String, String?>()
        val items = mutableListOf<PhoneReadLogic.Item>()

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            "${Telephony.Sms.DATE} >= ?",
            arrayOf(since.toString()),
            // No LIMIT in the sort order: not every provider accepts one. Counted here instead.
            "${Telephony.Sms.DATE} DESC",
        )?.use { cursor ->
            var scanned = 0
            while (cursor.moveToNext() && items.size < PhoneReadLogic.MAX_ITEMS && scanned++ < SMS_SCAN) {
                val address = cursor.getString(0) ?: continue
                val body = cursor.getString(1) ?: continue
                if (PhoneReadLogic.looksLikeOtp(body)) continue
                val contact = if (canName) names.getOrPut(address) { contactName(context, address) } else null
                val sender = PhoneReadLogic.senderLabel(address, contact, unknown)
                if (!PhoneReadLogic.nameMatches(sender, query.sender)) continue
                items += PhoneReadLogic.Item(sender = sender, text = body, at = cursor.getLong(2))
            }
        }
        return ok(items)
    }

    /** The contact's display name for a number, looked up here; the number itself stays here. */
    private fun contactName(context: Context, address: String): String? {
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address))
        return context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    }

    private fun queryOf(json: JSONObject?): PhoneReadLogic.Query? {
        if (json == null) return null
        return try {
            val queries = json.optJSONArray("queries")?.let { array -> List(array.length()) { array.getString(it) } }
            PhoneReadLogic.Query.of(
                kind = json.optString("kind"),
                queries = queries,
                app = text(json, "app"),
                sender = text(json, "sender"),
                hours = if (json.has("hours")) json.getInt("hours") else null,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun text(json: JSONObject, key: String): String? =
        if (json.has(key) && !json.isNull(key)) json.getString(key) else null

    private fun ok(items: List<PhoneReadLogic.Item>): JSONObject {
        val array = JSONArray()
        for (item in PhoneReadLogic.capped(items)) {
            val json = JSONObject()
            item.name?.let { json.put("name", it) }
            item.app?.let { json.put("app", it) }
            item.sender?.let { json.put("sender", it) }
            item.title?.let { json.put("title", it) }
            item.text?.let { json.put("text", it) }
            item.at?.let { json.put("at", it) }
            array.put(json)
        }
        return JSONObject().put("status", "ok").put("items", array)
    }

    /** `denied`: the permission is off. `unsupported`: a query this build does not know. */
    private fun refused(status: String): JSONObject = JSONObject().put("status", status).put("items", JSONArray())

    private fun granted(context: Context, permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
