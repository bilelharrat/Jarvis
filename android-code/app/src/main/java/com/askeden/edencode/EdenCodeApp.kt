package com.askeden.edencode

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.net.MacRoute
import com.askeden.edencode.net.MacRouter
import com.askeden.edencode.net.Pairing
import com.askeden.edencode.push.Push
import com.askeden.edencode.services.EdenWidget
import com.askeden.edencode.services.LiveSessionService
import com.askeden.edencode.services.Notifications
import com.askeden.edencode.services.Voice
import com.askeden.edencode.store.EdenCodeStore
import com.askeden.edencode.store.Platform
import com.askeden.edencode.store.SecureStore
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Eden Code for Android: its own app, on the same companion API, pairing, pinned TLS and relay as
 * the iPhone app (docs/eden-code-phone.md), with the same screens (android-code/README.md).
 */
class EdenCodeApp : Application() {
    lateinit var store: EdenCodeStore
        private set
    lateinit var platform: AndroidPlatform
        private set
    lateinit var voice: Voice
        private set

    override fun onCreate() {
        super.onCreate()
        Notifications.channels(this)
        val secure = SecureStore(this)
        // The relay is for the Mac in use, on this phone's Eden account token (when signed in).
        val router = MacRouter(accountToken = { secure.read("edencode.account.token") })
        MacRoute.router = router
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = router.networkChanged()
            override fun onLost(network: Network) = router.networkChanged()
        })
        platform = AndroidPlatform(this)
        voice = Voice(this)
        store = EdenCodeStore(this, platform, null)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                platform.front = true
                store.startPolling()
            }

            override fun onStop(owner: LifecycleOwner) {
                platform.front = false
                store.stopPolling()
                LiveSessionService.sync(this@EdenCodeApp, store.home, store.liveOn, false)
            }
        })
        Push.start(this)
    }
}

/** What the store asks of Android. */
class AndroidPlatform(private val app: Application) : Platform {
    @Volatile
    var front = false
    var activity: WeakReference<FragmentActivity>? = null

    override val inFront: Boolean get() = front

    override fun homeChanged(previous: PhoneHome?, home: PhoneHome, mac: String, liveOn: Boolean, inFront: Boolean) {
        EdenWidget.save(app, home, mac)
        LiveSessionService.sync(app, home, liveOn, inFront)
        if (!inFront) Notifications.postChanges(app, Notifications.changes(previous, home))
    }

    override fun registerPush(macs: List<Pairing>) = Push.registerAgain(app)

    /** BiometricPrompt: the fingerprint or face (strong), or the screen lock. False when not confirmed. */
    override suspend fun confirmOwner(reason: String): Boolean {
        val activity = activity?.get() ?: return false
        val allowed = if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        if (BiometricManager.from(activity).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) return false
        return suspendCancellableCoroutine { done ->
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (done.isActive) done.resume(true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (done.isActive) done.resume(false)
                }
            })
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(reason)
                    .setSubtitle("Eden Code checks it’s you before your Mac runs it.")
                    .setAllowedAuthenticators(allowed)
                    .build(),
            )
            done.invokeOnCancellation { prompt.cancelAuthentication() }
        }
    }
}
