package com.askeden.edencode

import com.askeden.edencode.model.ApprovalChoice
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.LooseDate
import com.askeden.edencode.model.Money
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneChanges
import com.askeden.edencode.model.PhoneEntry
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.model.PhoneHunkResult
import com.askeden.edencode.model.PhoneOK
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.model.PhoneReceipt
import com.askeden.edencode.model.PhoneReceipts
import com.askeden.edencode.model.PhoneRun
import com.askeden.edencode.model.PhoneTodos
import com.askeden.edencode.model.PhoneUsage
import com.askeden.edencode.model.PhoneView
import com.askeden.edencode.model.Spoken
import com.askeden.edencode.model.Transcript
import com.askeden.edencode.services.LiveSessionService
import com.askeden.edencode.services.Notifications
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Mac's answers read as leniently as the iPhone app reads them (PhoneModels.swift, Decoding.swift). */
class DecodersTest {
    private fun j(s: String) = JSONObject(s)

    @Test fun homeReadsSessionsCardsPinAndRuns() {
        val home = PhoneHome.from(j("""
            {"sessions": [
                {"id": 5, "title": "Fix share-sheet crash", "project": "askeden / site", "status": "working", "mode": "ask", "model": "Opus 5.5", "cost_usd": "1.42", "updated_at": 1760000000},
                {"id": "6", "title": "", "project": "askeden / site", "status": "NEEDS_YOU", "mode": "edits"},
                {"title": "no id: skipped"},
                {"id": 3, "project": "eden messenger", "status": "failed"},
                {"id": 9, "status": "weird"}
            ],
             "attention": [{"id": "c1", "question": "Run it?", "detail": "npm test", "tool": "Bash", "task_id": 5,
                            "choices": [{"id": "allow", "label": "Allow"}, {"id": "always", "label": "Always allow npm test"}, {"id": "deny", "label": "Deny"}]},
                           {"id": "c2", "question": "Which?", "ask_kind": "question", "mac_only": 1, "face_id": false, "task_id": 6,
                            "choices": [{"id": "opt0", "label": "A"}, {"id": "deny", "label": "Skip"}], "copy": ""},
                           {"question": "no id"}],
             "pinned": {"id": 5, "title": "Fix", "at": 1760000000123},
             "exterminator": [{"id": "r1", "project": "site", "round": 2, "rounds": 3, "step": "fix", "found": 4, "fixed": 1, "spent": 1.5, "spend_cap": 10, "task_id": 7}]}
        """))
        assertEquals(listOf(5, 6, 3, 9), home.sessions.map { it.id })
        assertEquals(CodeStatus.NeedsYou, home.sessions[1].status)
        assertEquals("askeden / site", home.sessions[1].title) // empty title falls back to the project
        assertEquals("Accept edits", home.sessions[1].modeLabel)
        assertEquals(1.42, home.sessions[0].costUSD, 1e-9)
        assertEquals(1_760_000_000_000L, home.sessions[0].updatedAt)
        assertEquals(CodeStatus.Unknown, home.sessions[3].status)
        assertEquals("Eden Code", home.sessions[3].title)
        assertEquals(2, home.attention.size)
        val bash = home.attention[0]
        assertTrue(bash.faceID) // a Bash card needs biometrics unless the Mac says otherwise
        assertTrue(bash.needsBiometrics(bash.yesChoices[0]))
        assertTrue(bash.isStanding(bash.yesChoices[1]))
        assertFalse(bash.needsBiometrics(bash.noChoice))
        assertEquals("code", bash.approval.source)
        val question = home.attention[1]
        assertTrue(question.macOnly)
        assertTrue(question.approval.isQuestion)
        assertNull(question.copy)
        assertEquals("Skip", question.noChoice.label)
        assertEquals(1_760_000_000_123.0, home.pinned!!.at, 0.0)
        assertEquals("Round 2 of 3 · fix · 4 found, 1 fixed · $1.50 of $10.00", home.exterminator[0].line)
        assertEquals(2, home.needsYouCount)
        assertEquals(listOf("askeden / site", "eden messenger", "Other"), home.byProject.map { it.first })
    }

    @Test fun choicesThatSayNo() {
        assertTrue(ApprovalChoice("deny", "Deny").isNegative)
        assertTrue(ApprovalChoice("x", "Don’t send").isNegative)
        assertTrue(ApprovalChoice("later", "Not now").isNegative)
        assertFalse(ApprovalChoice("allow", "Allow").isNegative)
        assertFalse(ApprovalChoice("always", "Always allow").isNegative)
    }

    @Test fun optionsFallBackToThePhonesTwoModes() {
        val o = PhoneOptions.from(j("""{"models": [{"ref": "claude:opus", "name": "Opus 5.5", "group": "Claude"}, {"ref": "", "name": "bad"}, {"ref": "g", "needs_key": true}],
            "projects": [{"name": "site", "branch": "main", "running": "2"}], "defaults": {"model": "claude:opus", "mode": "edits"}}"""))
        assertEquals(2, o.models.size)
        assertTrue(o.models[1].needsKey)
        assertEquals("g", o.models[1].name)
        assertEquals(listOf("ask", "edits"), o.modes.map { it.id })
        assertEquals(2, o.projects[0].running)
        assertEquals("edits", o.defaultMode)
        assertEquals("Opus 5.5", o.modelName("claude:opus"))
    }

    @Test fun modelRouterAndShortModeWordsFromTheMac() {
        // The 2026-10-16 shape (docs/eden-code-phone.md): Model Router first, names, notes, short mode words.
        val o = PhoneOptions.from(j("""{"models": [
            {"ref": "router", "name": "Model Router", "group": "", "note": "Picks the model and effort for each message", "needs_key": false, "router": true},
            {"ref": "custom:k", "name": "Kimi K2.7 Code", "group": "Your models", "note": "Moonshot", "needs_key": false, "router": false}],
            "modes": [{"id": "ask", "name": "Manual", "short": "Manual"}], "router": true, "defaults": {"model": "router", "mode": "ask"}}"""))
        assertTrue(o.models[0].router)
        assertEquals("Picks the model and effort for each message", o.models[0].note)
        assertEquals("Moonshot", o.models[1].note)
        assertFalse(o.models[1].router)
        assertTrue(o.router)
        assertEquals("Model Router", o.modelName("router"))
        // An older Mac's list (no router field) still marks a "router" ref.
        assertTrue(PhoneOptions.from(j("""{"models": [{"ref": "router", "name": "Model Router"}]}""")).models[0].router)
        val v = PhoneView.from(j("""{"id": 11, "mode": "auto", "mode_label": "Bypass permissions", "mode_short": "Bypass",
            "model": "router", "model_label": "Model Router", "routed_label": "Kimi K3", "router": true}"""))
        assertEquals("Bypass", v.modeShort)
        assertEquals("Bypass permissions", v.modeLabel)
        assertTrue(v.router)
        assertEquals("Kimi K3", v.routedLabel)
        // An older Mac sends neither: the short words are worked out here, as the Mac's composer has them.
        val old = PhoneView.from(j("""{"id": 3, "mode": "auto", "model": "opus", "model_label": "Claude Opus 5.5"}"""))
        assertEquals("Bypass", old.modeShort)
        assertFalse(old.router)
        assertEquals("", old.routedLabel)
    }

    @Test fun viewEntriesAndTheLongPollMerge() {
        val first = PhoneView.from(j("""{"id": 5, "title": "T", "status": "working", "doing": "Running tests", "mode": "ask", "model": "claude:opus", "model_label": "Opus 5.5",
            "live": "writing", "todos": [{"text": "a", "done": true}], "copy": {"branch": "b", "into": "main", "busy": false}, "next": 3, "seen": 2, "v": "x",
            "entries": [{"i": 1, "role": "user", "text": "hi"}, {"i": 2, "role": "tool", "text": "Running tests…"}, {"i": 3, "role": "assistant", "text": "ok"}, {"role": "user"}],
            "more": 1}"""))
        assertEquals(3, first.entries.size)
        assertTrue(first.more)
        assertEquals("Opus 5.5", first.modelLabel)
        assertEquals(PhoneView.Copy("b", "main", false), first.copy)
        var entries = Transcript.merge(emptyList(), first)
        val second = PhoneView.from(j("""{"id": 5, "entries": [{"i": 4, "role": "note", "text": "n"}, {"i": 3, "role": "assistant", "text": "dup"}],
            "changed": [{"i": 2, "role": "tool", "text": "Ran tests → 41 passed"}, {"i": 99, "role": "tool", "text": "unknown"}]}"""))
        entries = Transcript.merge(entries, second)
        assertEquals(listOf(1, 2, 3, 4), entries.map { it.i })
        assertEquals("Ran tests → 41 passed", entries[1].text) // changed replaces in place
        assertEquals("ok", entries[2].text) // a repeat of a known entry isn't taken twice
        val rows = Transcript.rows(entries)
        assertEquals(listOf("u1", "s2", "r3", "n4"), rows.map { it.key })
        assertTrue(first.entries[1].stepRunning)
        assertEquals("Working: Running tests", Transcript.statusLine(first))
    }

    @Test fun stepsReadTheirFirstLineAndFailures() {
        val e = PhoneEntry(1, PhoneEntry.Role.Tool, "Bash npm test → error: 2 failed\nmore")
        assertEquals("Bash npm test → error: 2 failed", e.stepLine)
        assertTrue(e.stepFailed)
        assertFalse(PhoneEntry(2, PhoneEntry.Role.Tool, "Read share.js").stepFailed)
    }

    @Test fun changesNumberTheirLinesForComments() {
        val c = PhoneChanges.from(j("""{"id": 5, "view": "turn", "files": [{"path": "a.js", "status": "M", "added": 2, "removed": 1, "hunks": [
            {"id": "h1", "n": 1, "old_start": 10, "new_start": 12, "kept": false, "lines": [[" ", "ctx"], ["-", "old"], ["+", "new1"], ["\\", "No newline"], ["+", "new2"], [" ", "tail"]]},
            {"n": 2, "lines": []}]}, {"path": ""}], "totals": {"files": 3, "hunks": 9}}"""))
        assertEquals(1, c.files.size)
        val lines = c.files[0].hunks[0].lines
        assertEquals(listOf(12, 11, 13, 14, 15), lines.map { it.number })
        assertEquals(listOf(PhoneChanges.Line.Kind.Context, PhoneChanges.Line.Kind.Removed, PhoneChanges.Line.Kind.Added, PhoneChanges.Line.Kind.Added, PhoneChanges.Line.Kind.Context), lines.map { it.kind })
        assertEquals(3, c.totalFiles)
        assertEquals(9, c.totalHunks)
        assertEquals(listOf("h1"), c.unkeptHunks)
        val result = PhoneHunkResult.from(j("""{"ok": true, "said": "Undone.", "changes": {"id": 5, "files": []}}"""))
        assertTrue(result.ok)
        assertEquals(0, result.changes!!.files.size)
    }

    @Test fun receiptRowsInTheMacsOrder() {
        val r = PhoneReceipts.from(j("""{"id": 5, "receipts": [{"i": 7, "text": "Proof", "receipt": {
            "risk": "medium", "why": "touches auth", "files": ["a", "b"],
            "tests": {"state": "passed", "passed_count": 41, "trusted": true},
            "integrity": {"lines": [{"text": "7 of 9 mutants caught"}]},
            "check": {"status": "ok"}, "selfcheck": {"verdict": "pass", "headline": "Checked in simulator"},
            "security": {"findings": []}, "guardrails": [{"action": "allowed"}],
            "assumptions": [{"risk": "low"}], "requirements": [{"status": "met"}, {"status": "missed"}]}}]}""")).receipts[0]
        assertEquals("Medium risk", r.riskLabel)
        assertEquals(2, r.fileCount)
        assertEquals(
            listOf("41 tests passed", "7 of 9 mutants caught", "Checked after the turn", "Checked in simulator", "Security scan clean", "Guardrails held", "1 assumption", "Requirements met 1 of 2"),
            r.rows.map { it.text },
        )
        assertEquals(PhoneReceipt.Row.Mark.Warn, r.rows.last().mark)
        assertEquals("No tests run", PhoneReceipt.rows(JSONObject()).single().text)
        val failing = PhoneReceipt.rows(j("""{"tests": {"state": "failed", "failed_count": 2}, "security": {"found": 1}, "assumptions": [{"risk": "high"}, {"risk": "low"}]}"""))
        assertEquals(listOf("2 tests failed", "1 security finding", "2 assumptions (1 high risk)"), failing.map { it.text })
    }

    @Test fun todosUsageAndOk() {
        val t = PhoneTodos.from(j("""{"cards": [{"id": "t1", "project": "a", "title": "x", "mode": "auto", "state": "todo"}, {"id": "t2", "project": "b", "state": "started", "task_id": 3}, {"project": "c"}]}"""))
        assertEquals(2, t.cards.size)
        assertTrue(t.cards[0].startsOnMacOnly && t.cards[0].waiting)
        assertEquals("Started", t.cards[1].stateLabel)
        assertEquals(listOf("a", "b"), t.byProject.map { it.first })
        val u = PhoneUsage.from(j("""{"today": 4.5, "day_cap": 20, "recent": [{"day": "d", "total": 1.5}, {"day": "e", "total": "2"}], "windows": [{"kind": "seven_day", "utilization": 0.61}, {"kind": "five_hour", "percent": 38}]}"""))
        assertEquals(38.0, u.fiveHour!!.percent!!, 1e-9)
        assertEquals(61.0, u.windows[0].percent!!, 1e-9)
        assertEquals("Weekly limit", u.windows[0].label)
        assertEquals(3.5, u.week, 1e-9)
        assertTrue(PhoneOK.from(JSONObject()).ok)
        assertEquals(5, PhoneOK.from(j("""{"ok": true, "id": "5", "steered": true}""")).id)
        assertEquals("$4.51", Money.text(4.51))
        assertEquals("$120", Money.text(120.0))
    }

    @Test fun datesInEveryShapeTheMacWrites() {
        assertEquals(1_760_000_000_000L, LooseDate.epoch(1_760_000_000.0))
        assertEquals(1_760_000_000_123L, LooseDate.epoch(1_760_000_000_123.0))
        assertEquals(1_760_000_000_000L, LooseDate.parse("2025-10-09T08:53:20Z"))
        assertTrue(LooseDate.parse("2026-09-29T14:30") != null)
        assertNull(LooseDate.parse("soon"))
    }

    @Test fun inboxSummaryAndSpokenText() {
        val home = PhoneHome.from(j("""{"attention": [{"id": "a", "question": "q"}, {"id": "b", "question": "q", "ask_kind": "question"}]}"""))
        assertEquals("An approval and a question", Transcript.summary(home.attention))
        assertEquals("2 approvals", Transcript.summary(listOf(home.attention[0], home.attention[0].copy(approval = home.attention[0].approval.copy(id = "z")))))
        assertEquals("Fixed share.js.. See this", Spoken.text("Fixed `web/chat/share.js`.\n\nSee **this**"))
    }

    @Test fun notificationsSayWhatChanged() {
        val before = PhoneHome.from(j("""{"sessions": [{"id": 1, "title": "A", "status": "working"}, {"id": 2, "title": "B", "status": "working"}, {"id": 3, "title": "C", "status": "working"}]}"""))
        val after = PhoneHome.from(j("""{"sessions": [{"id": 1, "title": "A", "status": "done"}, {"id": 2, "title": "B", "status": "needs_you"}, {"id": 3, "title": "C", "status": "failed"}],
            "attention": [{"id": "c9", "question": "Run a migration?", "task_id": 2}], "pinned": {"id": 3, "title": "C", "at": 5}}"""))
        val changes = Notifications.changes(before, after)
        assertEquals(listOf("Run a migration?", "Finished", "Stopped with a problem", "Carry on from your phone"), changes.map { it.title })
        assertEquals("edencode://inbox", changes[0].link)
        assertEquals(emptyList<Notifications.Change>(), Notifications.changes(null, after)) // nothing on the first look
        assertEquals(emptyList<Notifications.Change>(), Notifications.changes(after, after))
    }

    @Test fun theOngoingNotificationsWords() {
        val one = PhoneHome.from(j("""{"sessions": [{"id": 1, "title": "Fix crash", "project": "site", "status": "working"}, {"id": 2, "title": "Old", "status": "done"}]}"""))
        assertEquals("Fix crash" to "Working · site", LiveSessionService.liveText(one))
        val two = PhoneHome.from(j("""{"sessions": [{"id": 1, "title": "Fix crash", "status": "working"}, {"id": 2, "title": "Passkeys", "status": "needs_you"}]}"""))
        assertEquals("Passkeys" to "1 needs you · 1 running", LiveSessionService.liveText(two))
        assertNull(LiveSessionService.liveText(PhoneHome()))
    }

    @Test fun cardDecodesFromTheAttentionShape() {
        val card = PhoneCard.from(j("""{"id": "c", "question": "Land?", "copy": "slug-1", "choices": []}"""))
        assertEquals("slug-1", card.copy)
        assertEquals(listOf("allow", "deny"), card.approval.choices.map { it.id }) // no choices: the default pair
        assertEquals("jarvis", card.approval.source)
        assertEquals("", PhoneRun.from(JSONObject()).project)
    }
}
