package com.askeden.edencode

import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.SessionList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.TimeZone

/** The drawer's flat list (GDrawer): by day, and one coloured word for where each session is. */
class SessionListTest {
    private val zone = TimeZone.getTimeZone("Europe/Paris")
    // 2026-10-16 14:00 in Paris.
    private val now = 1_792_152_000_000L
    private val hour = 3_600_000L

    private fun s(id: Int, status: CodeStatus, at: Long?, title: String = "S$id", project: String = "askeden") =
        PhoneSummary(id, title, project, status, updatedAt = at)

    @Test fun groupsByTodayYesterdayAndEarlierInTheMacsOrder() {
        val groups = SessionList.groups(
            listOf(
                s(6, CodeStatus.NeedsYou, now - hour), s(5, CodeStatus.Working, now - 2 * hour),
                s(4, CodeStatus.Done, now - 20 * hour), // 18:00 yesterday
                s(3, CodeStatus.Done, now - 3 * 24 * hour), s(7, CodeStatus.Done, now - 13 * hour), // 01:00 today
            ),
            now = now, zone = zone,
        )
        assertEquals(listOf("Today", "Yesterday", "Earlier"), groups.map { it.title })
        assertEquals(listOf(6, 5, 7), groups[0].sessions.map { it.id })
        assertEquals(listOf(4), groups[1].sessions.map { it.id })
        assertEquals(listOf(3), groups[2].sessions.map { it.id })
    }

    @Test fun noTimeMeansTodayWhileItWorksElseEarlier() {
        val groups = SessionList.groups(listOf(s(1, CodeStatus.Working, null), s(2, CodeStatus.Done, null)), now = now, zone = zone)
        assertEquals(listOf("Today" to listOf(1), "Earlier" to listOf(2)), groups.map { g -> g.title to g.sessions.map { it.id } })
    }

    @Test fun searchKeepsTitlesAndProjectsAndDropsEmptyGroups() {
        val all = listOf(s(1, CodeStatus.Done, now, "Passkey sign-in"), s(2, CodeStatus.Done, now - 30 * hour, "Router", "jarvis"))
        assertEquals(listOf(1), SessionList.groups(all, "PASSKEY", now, zone).single().sessions.map { it.id })
        assertEquals("Yesterday", SessionList.groups(all, "jarvis", now, zone).single().title)
        assertEquals(emptyList<SessionList.Group>(), SessionList.groups(all, "nothing", now, zone))
    }

    @Test fun theWordsUnderATitle() {
        assertEquals("Needs your OK", SessionList.statusLine(CodeStatus.NeedsYou, today = false))
        assertEquals("Working…", SessionList.statusLine(CodeStatus.Working, today = false))
        assertEquals("Done · ready to review", SessionList.statusLine(CodeStatus.Done, today = true))
        assertNull(SessionList.statusLine(CodeStatus.Done, today = false))
        assertNull(SessionList.statusLine(CodeStatus.Idle, today = true))
        assertEquals("Working", SessionList.word(CodeStatus.Working))
        assertEquals("Needs your OK", SessionList.word(CodeStatus.NeedsYou))
    }
}
