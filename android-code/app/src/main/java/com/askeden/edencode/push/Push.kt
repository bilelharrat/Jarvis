package com.askeden.edencode.push

import android.content.Context
import com.askeden.edencode.BuildConfig
import com.askeden.edencode.EdenCodeApp
import com.askeden.edencode.services.Notifications
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch

/**
 * Pushes through Firebase Cloud Messaging, behind a config: with no firebase.properties at build
 * time (the owner's Firebase project), Firebase is never started and the app relies on its live
 * connection to the Mac while it runs (the ongoing notification's service). With it, the token goes
 * to every paired Mac's /api/push/register as `environment: "fcm"` — which the Mac takes once its
 * push sender speaks FCM (see android-code/README.md, owner steps).
 */
object Push {
    val configured: Boolean get() = BuildConfig.FCM_APP_ID.isNotEmpty() && BuildConfig.FCM_PROJECT_ID.isNotEmpty() && BuildConfig.FCM_API_KEY.isNotEmpty()

    @Volatile
    var token: String? = null
        private set

    fun start(context: Context) {
        if (!configured) return
        try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build(),
                )
            }
            FirebaseMessaging.getInstance().token.addOnSuccessListener { got(context, it) }
        } catch (_: Exception) {
        }
    }

    /** Again for every paired Mac (after pairing another). */
    fun registerAgain(context: Context) {
        token?.let { got(context, it) }
    }

    fun got(context: Context, value: String) {
        token = value
        val app = context.applicationContext as? EdenCodeApp ?: return
        app.store.scope.launch { app.store.registerPush(value) }
    }

    /**
     * A push's data, as the Mac sends it to the iPhone (`{kind, id, task_id, handoff}` under
     * "jarvis", flattened here): the notification to show and where its tap goes.
     */
    fun show(context: Context, data: Map<String, String>, title: String?, body: String?) {
        val kind = data["kind"]
        val task = data["task_id"]?.toIntOrNull()
        val card = data["id"]
        val handoff = data["handoff"] == "true"
        val link = when {
            kind == "code_approval" || kind == "code_needs_you" -> "edencode://inbox"
            task != null -> "edencode://session/$task"
            else -> "edencode://sessions"
        }
        val channel = if (kind == "code_approval" || kind == "code_needs_you") Notifications.CHANNEL_NEEDS else Notifications.CHANNEL_DONE
        Notifications.post(
            context, (card ?: link).hashCode(), channel, title ?: data["title"] ?: "Eden Code", body ?: data["body"] ?: "",
            Notifications.open(context, link, kind, card, task, handoff),
        )
    }
}

class EdenMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) = Push.got(this, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val app = application as? EdenCodeApp
        if (app != null && app.platform.inFront) app.store.scope.launch { app.store.refreshHome() }
        Push.show(this, message.data, message.notification?.title, message.notification?.body)
    }
}
