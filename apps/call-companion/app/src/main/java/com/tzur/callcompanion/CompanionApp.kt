package com.tzur.callcompanion

import android.app.Application

/**
 * The process's start (0.14): before anything else can act, the screen
 * agent's journal is settled — an action left `held` is refused and one left
 * `started` is `uncertain`, and both tasks are reported
 * ([ScreenAgentRunner.recover]). Nothing else happens here.
 */
class CompanionApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ScreenAgentRunner.recover(this)
    }
}
