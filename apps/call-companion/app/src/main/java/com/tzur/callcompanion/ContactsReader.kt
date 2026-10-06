package com.tzur.callcompanion

import android.content.Context
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal

/** Every contact that has a phone number, read on the device and kept in memory for one match. */
object ContactsReader {
    fun read(context: Context): List<Contact> {
        val byId = LinkedHashMap<Long, Pair<String, MutableList<PhoneNumber>>>()
        val projection = arrayOf(
            Phone.CONTACT_ID,
            Phone.DISPLAY_NAME_PRIMARY,
            Phone.NUMBER,
            Phone.IS_SUPER_PRIMARY,
            Phone.TYPE,
        )
        context.contentResolver.query(Phone.CONTENT_URI, projection, null, null, null)?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(Phone.CONTACT_ID)
            val nameCol = cursor.getColumnIndexOrThrow(Phone.DISPLAY_NAME_PRIMARY)
            val numberCol = cursor.getColumnIndexOrThrow(Phone.NUMBER)
            val primaryCol = cursor.getColumnIndexOrThrow(Phone.IS_SUPER_PRIMARY)
            val typeCol = cursor.getColumnIndexOrThrow(Phone.TYPE)
            while (cursor.moveToNext()) {
                val number = cursor.getString(numberCol) ?: continue
                val name = cursor.getString(nameCol) ?: continue
                val entry = byId.getOrPut(cursor.getLong(idCol)) { name to mutableListOf() }
                entry.second += PhoneNumber(
                    number = number,
                    isPrimary = cursor.getInt(primaryCol) != 0,
                    isMobile = cursor.getInt(typeCol) == Phone.TYPE_MOBILE,
                )
            }
        }
        return byId.map { (id, entry) -> Contact(id, entry.first, entry.second) }
    }

    /**
     * Every contact's postal address, as name and one-line address (2026-10-06,
     * navigating to a contact). Read here and kept in memory for one match.
     */
    fun addresses(context: Context): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        context.contentResolver.query(
            StructuredPostal.CONTENT_URI,
            arrayOf(StructuredPostal.DISPLAY_NAME_PRIMARY, StructuredPostal.FORMATTED_ADDRESS),
            null,
            null,
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.getString(0) ?: continue
                val address = cursor.getString(1)?.replace(Regex("\\s+"), " ")?.trim() ?: continue
                if (address.isNotEmpty()) out += name to address
            }
        }
        return out
    }
}
