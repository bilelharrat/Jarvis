package com.askeden.edencode

import com.askeden.edencode.model.Approval
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.SessionList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.TimeZone

/** The drawer's flat list, the session the app opens on, and the words (as the iPhone's PhoneModels). */
class SessionListTest {
    private val zone = TimeZone.getTimeZone("Europe/Paris")
    // 2026-10-16 14:00 in Paris.
    private val now = 1_792_152_000_000L
    private val hour = 3_600_000L

    private fun s(id: Int, status: CodeStatus, at: Long?, title: String = "S$id", project: String = "askeden") =
        PhoneSummary(id, title, project, status, updatedAt = at)

    private fun card(task: Int) = PhoneCard(Approval("c$task", "Allow?", taskID = task))

    @Test fun todayLeadsWithWhatNeedsYouThenNewestFirst() {
        val home = PhoneHome(
            listOf(
                s(5, CodeStatus.Working, now - hour), s(6, CodeStatus.NeedsYou, now - 2 * hour),
                s(4, CodeStatus.Done, now - 20 * hour), // 18:00 yesterday
                s(7, CodeStatus.Done, now - 13 * hour), // 01:00 today
                s(3, CodeStatus.Done, now - 3 * 24 * hour),
            ),
        )
        val groups = SessionList.groups(home, now = now, zone = zone)
        assertEquals(listOf("Today", "Yesterday", "Earlier"), groups.map { it.title })
        assertEquals(listOf(6, 5, 7), groups[0].sessions.map { it.id })
        assertEquals(listOf(4), groups[1].sessions.map { it.id })
        assertEquals(listOf(3), groups[2].sessions.map { it.id })
    }

    @Test fun workingOrWaitingIsAlwaysTodaysAndNoTimeIsEarlier() {
        val home = PhoneHome(
            listOf(s(1, CodeStatus.Working, now - 5 * 24 * hour), s(2, CodeStatus.Done, null), s(3, CodeStatus.Idle, now - 4 * 24 * hour)),
            attention = listOf(card(3)),
        )
        val groups = SessionList.groups(home, now = now, zone = zone)
        assertEquals(listOf("Today" to listOf(3, 1), "Earlier" to listOf(2)), groups.map { g -> g.title to g.sessions.map { it.id } })
    }

    @Test fun searchKeepsTitlesAndProjectsAndDropsEmptyGroups() {
        val home = PhoneHome(listOf(s(1, CodeStatus.Done, now, "Passkey sign-in"), s(2, CodeStatus.Done, now - 30 * hour, "Router", "jarvis")))
        assertEquals(listOf(1), SessionList.groups(home, "PASSKEY", now, zone).single().sessions.map { it.id })
        assertEquals("Yesterday", SessionList.groups(home, "jarvis", now, zone).single().title)
        assertEquals(emptyList<SessionList.Group>(), SessionList.groups(home, "nothing", now, zone))
    }

    @Test fun opensOnWhatNeedsYouElseTheNewestElseNothing() {
        assertEquals(6, SessionList.landingID(PhoneHome(listOf(s(5, CodeStatus.Working, now), s(6, CodeStatus.Done, now - hour)), attention = listOf(card(6)))))
        assertEquals(4, SessionList.landingID(PhoneHome(listOf(s(5, CodeStatus.Done, now - hour), s(4, CodeStatus.Done, now)))))
        assertEquals(5, SessionList.landingID(PhoneHome(listOf(s(5, CodeStatus.Done, null), s(4, CodeStatus.Done, null)))))
        assertNull(SessionList.landingID(PhoneHome()))
    }

    @Test fun theWords() {
        assertEquals("Working", SessionList.word(CodeStatus.Working))
        assertEquals("Needs your OK", SessionList.word(CodeStatus.NeedsYou))
        assertEquals("Waiting", SessionList.word(CodeStatus.Idle))
        assertEquals("Session", SessionList.word(CodeStatus.Unknown))
        assertEquals("Working…", SessionList.drawerWord(CodeStatus.Working))
        assertEquals("Done · ready to review", SessionList.drawerWord(CodeStatus.Done))
        assertEquals("Failed", SessionList.drawerWord(CodeStatus.Failed))
    }
}
