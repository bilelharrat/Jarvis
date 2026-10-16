package com.askeden.edencode.services

import android.app.Service
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.askeden.edencode.EdenCodeApp
import com.askeden.edencode.R
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneHome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Live Activity's Android equivalent: while a session works or waits on the owner, an ongoing
 * notification says what it's doing, and this foreground service keeps asking the Mac (every 10 s,
 * through the relay when away) so the phone hears when it needs the owner or finishes, with no push
 * service set up. Started while the app is in front (as the iPhone starts Live Activities), it stops
 * once nothing is live, the owner turns it off in Settings, or after six hours.
 */
class LiveSessionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loop: Job? = null
    private var started = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as EdenCodeApp
        val home = app.store.home
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        val notification = notification(this, home)
        if (notification == null) {
            // Started with startForegroundService, it must go to the foreground before it may stop,
            // or Android ends the app (ForegroundServiceDidNotStartInTimeException): the session
            // may have finished between the start and now.
            ServiceCompat.startForeground(
                this, Notifications.LIVE_ID,
                NotificationCompat.Builder(this, Notifications.CHANNEL_LIVE).setSmallIcon(R.drawable.ic_stat_eden)
                    .setContentTitle("Eden Code").setSilent(true).build(),
                type,
            )
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        ServiceCompat.startForeground(this, Notifications.LIVE_ID, notification, type)
        if (started == 0L) started = System.currentTimeMillis()
        if (loop?.isActive != true) loop = scope.launch {
            while (isActive) {
                delay(10_000)
                if (System.currentTimeMillis() - started > 6 * 3600_000L) break
                if (!app.platform.inFront) app.store.refreshHome()
                if (!app.store.liveOn || app.store.home.sessions.none { it.status.isLive }) break
            }
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        /** The ongoing notification for what's live, or null when nothing is. */
        fun notification(context: Context, home: PhoneHome): android.app.Notification? {
            val text = liveText(home) ?: return null
            val first = home.sessions.firstOrNull { it.status == CodeStatus.NeedsYou } ?: home.sessions.first { it.status.isLive }
            return NotificationCompat.Builder(context, Notifications.CHANNEL_LIVE)
                .setSmallIcon(R.drawable.ic_stat_eden)
                .setContentTitle(text.first)
                .setContentText(text.second)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setColor(if (first.status == CodeStatus.NeedsYou) 0xFFFF9500.toInt() else 0xFF007AFF.toInt())
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setProgress(0, 0, first.status == CodeStatus.Working)
                .setContentIntent(Notifications.open(context, "edencode://session/${first.id}", request = 7))
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build()
        }

        /** Title and line: one session by name, several by count; what needs the owner first. */
        fun liveText(home: PhoneHome): Pair<String, String>? {
            val live = home.sessions.filter { it.status.isLive }
            if (live.isEmpty()) return null
            val needs = live.count { it.status == CodeStatus.NeedsYou }
            val working = live.count { it.status == CodeStatus.Working }
            if (live.size == 1) {
                val s = live[0]
                return s.title to listOf(s.status.label, s.project).filter { it.isNotEmpty() }.joinToString(" · ")
            }
            val title = if (needs > 0) live.first { it.status == CodeStatus.NeedsYou }.title else live[0].title
            val parts = mutableListOf<String>()
            if (needs > 0) parts += "$needs need${if (needs == 1) "s" else ""} you"
            if (working > 0) parts += "$working running"
            return title to parts.joinToString(" · ")
        }

        /** Starts, updates or ends it for this /home. */
        fun sync(context: Context, home: PhoneHome, on: Boolean, inFront: Boolean) {
            val live = on && home.sessions.any { it.status.isLive }
            val nm = androidx.core.app.NotificationManagerCompat.from(context)
            if (!live) {
                context.stopService(Intent(context, LiveSessionService::class.java))
                nm.cancel(Notifications.LIVE_ID)
                return
            }
            if (!Notifications.allowed(context)) return
            if (inFront) {
                try {
                    ContextCompat.startForegroundService(context, Intent(context, LiveSessionService::class.java))
                } catch (_: Exception) {
                }
            } else {
                notification(context, home)?.let { try { nm.notify(Notifications.LIVE_ID, it) } catch (_: SecurityException) {} }
            }
        }
    }
}

/**
 * The home-screen widget (EdenCodeStatus on the iPhone): what needs the owner and what's running,
 * up to four sessions, each opening its session. The app keeps its snapshot fresh.
 */
class EdenWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, views(context))
    }

    companion object {
        private const val PREFS = "edencode.widget"
        private val rows = listOf(
            Triple(R.id.row0, R.id.dot0, R.id.title0), Triple(R.id.row1, R.id.dot1, R.id.title1),
            Triple(R.id.row2, R.id.dot2, R.id.title2), Triple(R.id.row3, R.id.dot3, R.id.title3),
        )

        data class Snapshot(val mac: String, val needsYou: Int, val working: Int, val items: List<Item>) {
            data class Item(val id: Int, val title: String, val project: String, val status: String)

            fun json(): String = JSONObject().apply {
                put("mac", mac); put("needsYou", needsYou); put("working", working)
                put("items", JSONArray().apply { items.forEach { put(JSONObject().put("id", it.id).put("title", it.title).put("project", it.project).put("status", it.status)) } })
            }.toString()

            companion object {
                fun of(home: PhoneHome, mac: String): Snapshot {
                    val live = home.sessions.filter { it.status.isLive }
                    return Snapshot(
                        mac, home.needsYouCount, home.sessions.count { it.status == CodeStatus.Working },
                        (live + home.sessions.filter { !it.status.isLive }).take(4).map { Item(it.id, it.title, it.project, it.status.raw) },
                    )
                }

                fun parse(text: String?): Snapshot? = try {
                    val o = JSONObject(text ?: return null)
                    val a = o.optJSONArray("items") ?: JSONArray()
                    Snapshot(o.optString("mac"), o.optInt("needsYou"), o.optInt("working"), (0 until a.length()).map {
                        val i = a.getJSONObject(it)
                        Item(i.optInt("id"), i.optString("title"), i.optString("project"), i.optString("status"))
                    })
                } catch (_: Exception) {
                    null
                }
            }
        }

        fun save(context: Context, home: PhoneHome, mac: String) {
            val snapshot = Snapshot.of(home, mac)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (Snapshot.parse(prefs.getString("snapshot", null)) == snapshot) return
            prefs.edit().putString("snapshot", snapshot.json()).apply()
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, EdenWidget::class.java))
            for (id in ids) manager.updateAppWidget(id, views(context))
        }

        private fun dot(status: String) = when (status) {
            "working" -> R.drawable.dot_blue
            "needs_you" -> R.drawable.dot_orange
            "done" -> R.drawable.dot_green
            "failed" -> R.drawable.dot_red
            else -> R.drawable.dot_gray
        }

        fun views(context: Context): RemoteViews {
            val s = Snapshot.parse(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("snapshot", null))
                ?: Snapshot("", 0, 0, emptyList())
            val v = RemoteViews(context.packageName, R.layout.widget_status)
            v.setViewVisibility(R.id.badge, if (s.needsYou > 0) View.VISIBLE else View.GONE)
            v.setTextViewText(R.id.badge, "${s.needsYou}")
            v.setViewVisibility(R.id.empty, if (s.items.isEmpty()) View.VISIBLE else View.GONE)
            v.setOnClickPendingIntent(R.id.header, Notifications.open(context, "edencode://inbox", request = 100))
            rows.forEachIndexed { i, (row, dotId, title) ->
                val item = s.items.getOrNull(i)
                v.setViewVisibility(row, if (item == null) View.GONE else View.VISIBLE)
                if (item != null) {
                    v.setImageViewResource(dotId, dot(item.status))
                    v.setTextViewText(title, item.title)
                    v.setOnClickPendingIntent(row, Notifications.open(context, "edencode://session/${item.id}", request = 200 + i))
                }
            }
            return v
        }
    }
}
