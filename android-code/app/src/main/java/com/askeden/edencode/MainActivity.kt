package com.askeden.edencode

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.askeden.edencode.ui.EdenTheme
import com.askeden.edencode.ui.Root
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine

/** The one activity: edge to edge under clear system bars, the Compose screens, links and notification taps. */
class MainActivity : FragmentActivity() {
    private val app get() = application as EdenCodeApp
    private var micWaiting: CancellableContinuation<Boolean>? = null
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micWaiting?.takeIf { it.isActive }?.resume(granted)
        micWaiting = null
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        app.platform.activity = WeakReference(this)
        app.voice.askMicrophone = {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) true
            else suspendCancellableCoroutine { done ->
                micWaiting = done
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
        DebugLaunch.apply(intent, app.store)
        // Asks once, as the iPhone asks for notifications at first launch.
        if (Build.VERSION.SDK_INT >= 33 && !DebugLaunch.active &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        handle(intent)
        setContent { EdenTheme { Root(app.store, app.voice) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        if (app.platform.activity?.get() === this) app.platform.activity = null
        super.onDestroy()
    }

    /** A notification tapped (its kind, card and session) or an edencode:// link (a widget row). */
    private fun handle(intent: Intent?) {
        intent ?: return
        val kind = intent.getStringExtra("kind")
        val task = if (intent.hasExtra("task")) intent.getIntExtra("task", 0) else null
        if (kind != null) {
            app.store.open(kind, intent.getStringExtra("card"), task, intent.getBooleanExtra("handoff", false))
            return
        }
        intent.data?.toString()?.let { app.store.open(it) }
    }
}
