package com.tzur.callcompanion

import android.content.Intent

/**
 * One call request after matching: the dispatch it answers and who it could
 * mean. Lives only in intent extras on this phone — never written to storage,
 * never sent to the server.
 */
class CallRequest(val dispatchId: String, val expiresAt: Long, val candidates: List<Candidate>) {
    /** What the report says about the match: a count, never a name. */
    val matched: String get() = if (candidates.size == 1) "one" else "many"

    fun isExpired(now: Long = System.currentTimeMillis()): Boolean = now >= expiresAt

    fun into(intent: Intent): Intent = intent
        .putExtra(EXTRA_ID, dispatchId)
        .putExtra(EXTRA_EXPIRES, expiresAt)
        .putStringArrayListExtra(EXTRA_NAMES, ArrayList(candidates.map { it.name }))
        .putStringArrayListExtra(EXTRA_NUMBERS, ArrayList(candidates.map { it.number }))

    companion object {
        private const val EXTRA_ID = "dispatch_id"
        private const val EXTRA_EXPIRES = "expires_at"
        private const val EXTRA_NAMES = "names"
        private const val EXTRA_NUMBERS = "numbers"

        fun from(intent: Intent?): CallRequest? {
            if (intent == null) return null
            val id = intent.getStringExtra(EXTRA_ID) ?: return null
            val names = intent.getStringArrayListExtra(EXTRA_NAMES) ?: return null
            val numbers = intent.getStringArrayListExtra(EXTRA_NUMBERS) ?: return null
            if (names.isEmpty() || names.size != numbers.size) return null
            val expires = intent.getLongExtra(EXTRA_EXPIRES, 0L)
            return CallRequest(id, expires, names.zip(numbers) { n, p -> Candidate(n, p) })
        }
    }
}
