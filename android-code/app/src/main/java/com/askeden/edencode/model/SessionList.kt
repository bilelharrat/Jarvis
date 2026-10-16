package com.askeden.edencode.model

import java.util.Calendar
import java.util.TimeZone

/**
 * The drawer's one flat list of sessions (the G design's GDrawer mockup, 2026-10-16): grouped by
 * when they last moved (Today, Yesterday, Earlier), each with one coloured word for where it is.
 * Plain Kotlin so the JVM tests can check it. Cost policy: no model calls, nothing on the network.
 */
object SessionList {
    data class Group(val title: String, val sessions: List<PhoneSummary>)

    /**
     * Sessions by day, newest group first, in the order the Mac sent them (newest first). A session
     * the Mac gave no time for counts as Today while it works or waits, else Earlier. [query]
     * keeps the ones whose title or project has it.
     */
    fun groups(
        sessions: List<PhoneSummary>,
        query: String = "",
        now: Long = System.currentTimeMillis(),
        zone: TimeZone = TimeZone.getDefault(),
    ): List<Group> {
        val q = query.trim().lowercase()
        val kept = if (q.isEmpty()) sessions else sessions.filter { it.title.lowercase().contains(q) || it.project.lowercase().contains(q) }
        val today = dayStart(now, zone)
        val yesterday = dayStart(today - 1, zone)
        val buckets = linkedMapOf("Today" to mutableListOf<PhoneSummary>(), "Yesterday" to mutableListOf(), "Earlier" to mutableListOf())
        for (s in kept) {
            val at = s.updatedAt
            val key = when {
                at == null -> if (s.status.isLive) "Today" else "Earlier"
                at >= today -> "Today"
                at >= yesterday -> "Yesterday"
                else -> "Earlier"
            }
            buckets.getValue(key).add(s)
        }
        return buckets.filterValues { it.isNotEmpty() }.map { Group(it.key, it.value) }
    }

    /**
     * The line under a session's title in the drawer, or null for none: a session that works or
     * waits always says so; one that finished or failed says it only on the day it did (the mockup
     * leaves older ones as bare titles).
     */
    fun statusLine(status: CodeStatus, today: Boolean): String? = when (status) {
        CodeStatus.NeedsYou -> "Needs your OK"
        CodeStatus.Working -> "Working…"
        CodeStatus.Done -> if (today) "Done · ready to review" else null
        CodeStatus.Failed -> if (today) "Failed" else null
        else -> null
    }

    /** The one word in a session's title pill ("Working · askeden"). */
    fun word(status: CodeStatus): String = when (status) {
        CodeStatus.NeedsYou -> "Needs your OK"
        CodeStatus.Working -> "Working"
        CodeStatus.Done -> "Done"
        CodeStatus.Failed -> "Failed"
        CodeStatus.Idle, CodeStatus.Resting -> "Idle"
        CodeStatus.Unknown -> ""
    }

    private fun dayStart(at: Long, zone: TimeZone): Long = Calendar.getInstance(zone).run {
        timeInMillis = at
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        timeInMillis
    }
}
