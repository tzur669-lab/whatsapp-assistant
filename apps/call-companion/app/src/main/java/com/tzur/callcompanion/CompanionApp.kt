package com.tzur.callcompanion

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network

/**
 * The process's start (0.14): before anything else can act, the screen
 * agent's journal is settled — an action left `held` is refused and one left
 * `started` is `uncertain`, and both tasks are reported
 * ([ScreenAgentRunner.recover]). Then (0.15) the watch list is fetched again
 * and matches still waiting are sent, now and whenever the network returns
 * ([Watches], PLAN §6.30).
 */
class CompanionApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ScreenAgentRunner.recover(this)
        if (Signer(this).isPaired) Watches.refresh(this)
        try {
            getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) = Watches.flush(this@CompanionApp)
                },
            )
        } catch (_: Exception) {
            // Without the callback, waiting matches go out on the next start or push.
        }
    }
}
