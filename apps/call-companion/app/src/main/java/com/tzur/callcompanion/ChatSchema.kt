package com.tzur.callcompanion

/**
 * The chat database's schema steps that need no Android ([ChatStore] runs
 * them), so the JVM tests can pin them.
 */
object ChatSchema {
    const val VERSION = 4

    /** The conversations table as it is now. Version 4 added `mode` (0.12). */
    val CREATE_CONVERSATIONS = """
        CREATE TABLE conversations (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          mode       TEXT NOT NULL DEFAULT '${Protocol.MODE_LOCAL}'
        )
    """.trimIndent()

    /** Every conversation before 0.12 was local, and stays local. */
    const val ADD_MODE = "ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT '${Protocol.MODE_LOCAL}'"

    /**
     * What to run on the conversations table once it exists, from [oldVersion].
     * Below 3 the table is created by [CREATE_CONVERSATIONS] already with `mode`,
     * so the column is added only to a table from version 3.
     */
    fun conversationSteps(oldVersion: Int): List<String> =
        if (oldVersion == 3) listOf(ADD_MODE) else emptyList()

    /** A stored mode read back: anything but `smart` is local, the safe side. */
    fun modeOf(stored: String?): String = if (stored == Protocol.MODE_SMART) Protocol.MODE_SMART else Protocol.MODE_LOCAL
}
