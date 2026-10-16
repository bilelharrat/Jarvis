package com.askeden.edencode.model

import java.util.Calendar
import java.util.TimeZone

/**
 * The G design's session list (PhoneModels.swift's drawerGroups, landingID, GStatus): the
 * drawer's one flat list by day, the session the app opens on, and the one coloured word for
 * where a session is. Plain Kotlin so the JVM tests check it. Cost policy: no model calls,
 * nothing on the network.
 */
object SessionList {
    data class Group(val title: String, val sessions: List<PhoneSummary>)

    /** Waits on the owner: a card for it, or its status says so. */
    fun needsYou(home: PhoneHome, s: PhoneSummary): Boolean =
        s.status == CodeStatus.NeedsYou || home.attention.any { it.taskID == s.id }

    /** Newest first by updated_at; the Mac's own order where it doesn't say. */
    fun newestFirst(list: List<PhoneSummary>): List<PhoneSummary> =
        list.withIndex().sortedWith(compareByDescending<IndexedValue<PhoneSummary>> { it.value.updatedAt ?: Long.MIN_VALUE }.thenBy { it.index }).map { it.value }

    /** What the app opens on: the session that waits on the owner, else the newest one; null for the New page. */
    fun landingID(home: PhoneHome): Int? =
        home.sessions.firstOrNull { needsYou(home, it) }?.id ?: newestFirst(home.sessions).firstOrNull()?.id

    /**
     * The drawer's list: Today (what needs the owner first, then newest first), Yesterday,
     * Earlier. A session that works or waits is always Today's, whenever it began; one the Mac
     * gives no time is Earlier's. [query] matches the title or the project.
     */
    fun groups(
        home: PhoneHome,
        query: String = "",
        now: Long = System.currentTimeMillis(),
        zone: TimeZone = TimeZone.getDefault(),
    ): List<Group> {
        val q = query.trim().lowercase()
        val kept = newestFirst(home.sessions).filter { q.isEmpty() || it.title.lowercase().contains(q) || it.project.lowercase().contains(q) }
        val todayStart = dayStart(now, zone)
        val yesterdayStart = dayStart(todayStart - 1, zone)
        val today = mutableListOf<PhoneSummary>()
        val yesterday = mutableListOf<PhoneSummary>()
        val earlier = mutableListOf<PhoneSummary>()
        for (s in kept) {
            val at = s.updatedAt
            when {
                needsYou(home, s) || s.status == CodeStatus.Working -> today += s
                at != null && at >= todayStart -> today += s
                at != null && at >= yesterdayStart -> yesterday += s
                else -> earlier += s
            }
        }
        val ranked = today.withIndex().sortedWith(compareBy<IndexedValue<PhoneSummary>> { if (needsYou(home, it.value)) 0 else 1 }.thenBy { it.index }).map { it.value }
        return listOf(Group("Today", ranked), Group("Yesterday", yesterday), Group("Earlier", earlier)).filter { it.sessions.isNotEmpty() }
    }

    /** The title pill's word: "Working", "Needs your OK", "Done". */
    fun word(status: CodeStatus): String = when (status) {
        CodeStatus.Working -> "Working"
        CodeStatus.NeedsYou -> "Needs your OK"
        CodeStatus.Done -> "Done"
        CodeStatus.Failed -> "Failed"
        CodeStatus.Idle, CodeStatus.Resting -> "Waiting"
        CodeStatus.Unknown -> "Session"
    }

    /** The drawer's word (Today's rows): "Working…", "Needs your OK", "Done · ready to review". */
    fun drawerWord(status: CodeStatus): String = when (status) {
        CodeStatus.Working -> "Working…"
        CodeStatus.Done -> "Done · ready to review"
        else -> word(status)
    }

    private fun dayStart(at: Long, zone: TimeZone): Long = Calendar.getInstance(zone).run {
        timeInMillis = at
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        timeInMillis
    }
}
