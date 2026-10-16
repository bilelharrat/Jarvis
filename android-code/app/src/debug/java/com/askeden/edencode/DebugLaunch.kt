package com.askeden.edencode

import android.content.Intent
import com.askeden.edencode.store.EdenCodeStore
import com.askeden.edencode.ui.DebugComposer
import com.askeden.edencode.ui.DebugPairing
import kotlinx.coroutines.launch

/**
 * Debug-build-only launch extras (the iPhone app's EdenDebug), e.g.
 *
 *     adb shell am start -n com.askeden.edencode/.MainActivity --es EDENCODEFixtures YES --es EDENCODEOpen session:5
 *
 * EDENCODEFixtures YES: sample sessions instead of a Mac (to look at the screens): the demo's
 *   data (net/DemoBackend.kt) without its banner, so screenshots match the iPhone's.
 * EDENCODEOpen session:<id> | changes:<id> | approve (the first card, in its session) | overlay (a card over
 *   the screen, as one with no session shows) | drawer[:<id>] | inbox | queue | settings | new | pair
 * EDENCODEServer host:port, EDENCODECode 123456: pairs with a test Mac at launch.
 * EDENCODEDemo YES: what "Try a demo" does (banner and all), then EDENCODEOpen as above.
 * EDENCODEReset YES: forgets every paired Mac. EDENCODETyped <text>, EDENCODEComposerOpen YES.
 * None of this exists in release builds (src/release has an empty one).
 */
object DebugLaunch {
    var active = false
        private set

    private fun Intent.flag(name: String): Boolean {
        val s = getStringExtra(name)?.lowercase()
        return s == "yes" || s == "true" || s == "1" || getBooleanExtra(name, false)
    }

    fun apply(intent: Intent?, store: EdenCodeStore) {
        intent ?: return
        if (intent.flag("EDENCODEReset")) store.forgetAll()
        DebugPairing.server = intent.getStringExtra("EDENCODEServer")
        DebugPairing.code = intent.getStringExtra("EDENCODECode")
        DebugComposer.typed = intent.getStringExtra("EDENCODETyped")
        DebugComposer.open = intent.flag("EDENCODEComposerOpen")
        if (intent.flag("EDENCODEDemo")) {
            active = true
            store.startDemo()
        } else {
            if (!intent.flag("EDENCODEFixtures")) return
            active = true
            store.useFixtures(com.askeden.edencode.net.DemoBackend.fixtures())
        }
        val open = intent.getStringExtra("EDENCODEOpen") ?: return
        val parts = open.split(":")
        val id = parts.getOrNull(1)?.toIntOrNull() ?: 5
        store.scope.launch {
            store.refreshHome()
            when (parts.first()) {
                "session" -> store.open(session = id)
                "changes" -> store.openChanges(id)
                "approve" -> store.home.attention.firstOrNull()?.let { store.showCard(it) }
                "overlay" -> store.sheetCard = store.home.attention.firstOrNull()
                "drawer" -> { if (parts.size > 1) store.open(session = id); store.drawerOpen = true }
                "inbox" -> store.show(EdenCodeStore.Panel.Inbox)
                "queue" -> store.show(EdenCodeStore.Panel.Queue)
                "settings" -> store.show(EdenCodeStore.Panel.Settings)
                "new" -> store.newSession()
                "pair" -> store.showPairing = true
            }
        }
    }
}
