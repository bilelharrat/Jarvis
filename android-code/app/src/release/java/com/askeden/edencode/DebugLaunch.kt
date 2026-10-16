package com.askeden.edencode

import android.content.Intent
import com.askeden.edencode.store.EdenCodeStore

/** Release builds have no debug launch extras and no sample sessions (src/debug has them). */
object DebugLaunch {
    const val active = false

    @Suppress("UNUSED_PARAMETER")
    fun apply(intent: Intent?, store: EdenCodeStore) {}
}
