package com.askeden.edencode.services

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.askeden.edencode.MainActivity
import com.askeden.edencode.R
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneHome

/**
 * The phone's own notifications. While the app runs (in front, or behind it with the ongoing
 * notification's service polling), what changes on the Mac is noticed here and said here: a session
 * that needs the owner, finishes or fails, and a card that waits. Pushes through Firebase, once the
 * owner sets it up, land in the same channels (push/EdenMessagingService).
 */
object Notifications {
    const val CHANNEL_NEEDS = "needs_you"
    const val CHANNEL_DONE = "finished"
    const val CHANNEL_LIVE = "running"
    const val LIVE_ID = 1

    fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A session asks for your OK or a question waits on you."
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_DONE, "Finished and failed", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A session finished or stopped with a problem, or your Mac handed one to this phone."
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_LIVE, "Running sessions", NotificationManager.IMPORTANCE_LOW).apply {
            description = "What a running session is doing, while it runs."
            setShowBadge(false)
        })
    }

    fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Opens the app at an edencode:// link, with what the store's open(kind:…) needs. */
    fun open(context: Context, link: String, kind: String? = null, card: String? = null, task: Int? = null, handoff: Boolean = false, request: Int = link.hashCode()): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            kind?.let { putExtra("kind", it) }
            card?.let { putExtra("card", it) }
            task?.let { putExtra("task", it) }
            putExtra("handoff", handoff)
        }
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun post(context: Context, id: Int, channel: String, title: String, text: String, tap: PendingIntent) {
        if (!allowed(context)) return
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_eden)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setColor(0xFF007AFF.toInt())
            .setCategory(if (channel == CHANNEL_NEEDS) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (channel == CHANNEL_NEEDS) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, n)
        } catch (_: SecurityException) {
        }
    }

    /** What changed between two /home answers that's worth a notification. */
    data class Change(val id: Int, val channel: String, val title: String, val text: String, val link: String, val kind: String, val card: String? = null, val task: Int? = null)

    fun changes(previous: PhoneHome?, home: PhoneHome): List<Change> {
        if (previous == null) return emptyList()
        val out = mutableListOf<Change>()
        val before = previous.sessions.associateBy { it.id }
        val seenCards = previous.attention.map { it.id }.toSet()
        for (card in home.attention) {
            if (card.id in seenCards) continue
            val session = home.sessions.firstOrNull { it.id == card.taskID }
            out += Change(
                card.id.hashCode(), CHANNEL_NEEDS, card.approval.question, listOfNotNull(session?.title, session?.project?.ifEmpty { null }).joinToString(" · ").ifEmpty { "Eden Code is waiting on your answer." },
                "edencode://inbox", "code_approval", card.id, card.taskID,
            )
        }
        val carded = home.attention.mapNotNull { it.taskID }.toSet()
        for (s in home.sessions) {
            val was = before[s.id]?.status ?: continue
            if (was == s.status) continue
            when (s.status) {
                CodeStatus.NeedsYou -> if (s.id !in carded) out += Change(10_000 + s.id, CHANNEL_NEEDS, "Needs you", s.title, "edencode://session/${s.id}", "code_needs_you", task = s.id)
                CodeStatus.Done -> if (was == CodeStatus.Working) out += Change(20_000 + s.id, CHANNEL_DONE, "Finished", s.title, "edencode://session/${s.id}", "code_done", task = s.id)
                CodeStatus.Failed -> out += Change(20_000 + s.id, CHANNEL_DONE, "Stopped with a problem", s.title, "edencode://session/${s.id}", "code_failed", task = s.id)
                else -> {}
            }
        }
        val pin = home.pinned
        if (pin != null && pin.at > (previous.pinned?.at ?: 0.0)) {
            out += Change(30_000 + pin.id, CHANNEL_DONE, "Carry on from your phone", pin.title.ifEmpty { "A session from your Mac" }, "edencode://session/${pin.id}", "code_done", task = pin.id)
        }
        return out
    }

    fun postChanges(context: Context, changes: List<Change>) {
        for (ch in changes) post(context, ch.id, ch.channel, ch.title, ch.text, open(context, ch.link, ch.kind, ch.card, ch.task, request = ch.id))
    }
}
