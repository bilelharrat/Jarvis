package com.askeden.edencode

import android.content.Intent
import com.askeden.edencode.model.Approval
import com.askeden.edencode.model.ApprovalChoice
import com.askeden.edencode.model.CodeModes
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneChanges
import com.askeden.edencode.model.PhoneComment
import com.askeden.edencode.model.PhoneEntry
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.model.PhoneHunkResult
import com.askeden.edencode.model.PhoneOK
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.model.PhoneReceipt
import com.askeden.edencode.model.PhoneReceipts
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.PhoneTodoCard
import com.askeden.edencode.model.PhoneTodos
import com.askeden.edencode.model.PhoneUsage
import com.askeden.edencode.model.PhoneView
import com.askeden.edencode.net.CodeBackend
import com.askeden.edencode.net.Pairing
import com.askeden.edencode.net.Picture
import com.askeden.edencode.store.EdenCodeStore
import com.askeden.edencode.store.Fixtures
import com.askeden.edencode.ui.DebugComposer
import com.askeden.edencode.ui.DebugPairing
import kotlinx.coroutines.launch

/**
 * Debug-build-only launch extras (the iPhone app's EdenDebug), e.g.
 *
 *     adb shell am start -n com.askeden.edencode/.MainActivity --es EDENCODEFixtures YES --es EDENCODEOpen session:5
 *
 * EDENCODEFixtures YES: sample sessions instead of a Mac (to look at the screens).
 * EDENCODEOpen session:<id> | changes:<id> | ask (session 6 and its card) | approve (a card over the screen)
 *   | drawer | inbox | queue | settings | new | pair
 * EDENCODEServer host:port, EDENCODECode 123456: pairs with a test Mac at launch.
 * EDENCODEReset YES: forgets every paired Mac. EDENCODETyped <text>, EDENCODEComposerOpen YES.
 * None of this exists in release builds (src/release has an empty one).
 */
object DebugLaunch {
    var active = false
        private set

    private fun Intent.flag(name: String): Boolean {
        val s = getStringExtra(name)?.lowercase()
        return s == "yes" || s == "true" || s == "1" || getBooleanExtra(name, false)
    }

    fun apply(intent: Intent?, store: EdenCodeStore) {
        DebugPairing.useFixtures = { store.useFixtures(FixtureBackend.fixtures) }
        intent ?: return
        if (intent.flag("EDENCODEReset")) store.forgetAll()
        DebugPairing.server = intent.getStringExtra("EDENCODEServer")
        DebugPairing.code = intent.getStringExtra("EDENCODECode")
        DebugComposer.typed = intent.getStringExtra("EDENCODETyped")
        DebugComposer.open = intent.flag("EDENCODEComposerOpen")
        if (!intent.flag("EDENCODEFixtures")) return
        active = true
        store.useFixtures(FixtureBackend.fixtures)
        val open = intent.getStringExtra("EDENCODEOpen") ?: return
        val parts = open.split(":")
        val id = parts.getOrNull(1)?.toIntOrNull() ?: 5
        store.scope.launch {
            store.refreshHome()
            when (parts.first()) {
                "session" -> store.open(session = id)
                "changes" -> store.openChanges(id)
                "ask" -> store.open(session = 6)
                "approve" -> store.sheetCard = store.home.attention.firstOrNull()
                "drawer", "sessions" -> { store.open(session = 5); store.drawerOpen = true }
                "inbox" -> store.show(EdenCodeStore.Tab.Inbox)
                "queue" -> store.show(EdenCodeStore.Tab.Queue)
                "settings" -> store.show(EdenCodeStore.Tab.Settings)
                "new" -> store.newSession()
                "pair" -> store.showPairing = true
            }
        }
    }
}

private fun today(minutesAgo: Int): Long {
    val now = System.currentTimeMillis()
    val midnight = java.util.Calendar.getInstance().apply {
        set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0); set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
    }.timeInMillis
    return maxOf(midnight + 60_000L * (60 - minutesAgo / 2), now - 60_000L * minutesAgo).coerceAtMost(now)
}

private fun daysAgo(days: Int): Long = System.currentTimeMillis() - days * 86_400_000L - 3_600_000L

/** Sample data for every screen, as a Mac would answer it (the iPhone app's FixtureBackend, the same data). */
class FixtureBackend : CodeBackend {
    companion object {
        val shared = FixtureBackend()
        val macs = listOf(
            Pairing("https://macbook-air.local:8765", "fixture", "MacBook Air", "Android", System.currentTimeMillis(), "ab".repeat(32)),
            Pairing("https://studio.local:8765", "fixture", "Mac Studio", "Android", System.currentTimeMillis(), "cd".repeat(32)),
        )
        val fixtures = object : Fixtures {
            override val backend: CodeBackend = shared
            override val macs: List<Pairing> = FixtureBackend.macs
        }

        val migrationCard = PhoneCard(
            Approval(
                "c-migrate", "Can I add the passkeys table?", "wrangler d1 migrations apply eden --remote",
                listOf(ApprovalChoice("allow", "Allow"), ApprovalChoice("always", "Always allow migrations in this project"), ApprovalChoice("deny", "Deny")),
                source = "code", taskID = 6,
            ),
            faceID = true, tool = "Bash",
        )
        val questionCard = PhoneCard(
            Approval(
                "c-question", "Which sign-in should the button use?", "",
                listOf(ApprovalChoice("opt0", "Passkey first"), ApprovalChoice("opt1", "Email link first"), ApprovalChoice("deny", "Skip")),
                source = "code", taskID = 6, askKind = "question",
            ),
            tool = "AskUserQuestion",
        )
        val receipt = PhoneReceipt(
            7, "Proof · Changed 2 files · tests passed (41)", "low", "small, tested change", 2,
            listOf(
                PhoneReceipt.Row(PhoneReceipt.Row.Mark.Good, "41 tests passed"), PhoneReceipt.Row(PhoneReceipt.Row.Mark.Good, "7 of 9 mutants caught"),
                PhoneReceipt.Row(PhoneReceipt.Row.Mark.Good, "Security scan clean"), PhoneReceipt.Row(PhoneReceipt.Row.Mark.Good, "Checked in simulator"),
                PhoneReceipt.Row(PhoneReceipt.Row.Mark.Warn, "1 assumption"), PhoneReceipt.Row(PhoneReceipt.Row.Mark.Good, "Guardrails held"),
            ),
        )
    }

    private val kept = mutableSetOf("h3")

    val homeNow: PhoneHome
        get() = PhoneHome(
            // The G mockups' sessions (GDrawer): four today, two yesterday, two earlier.
            sessions = listOf(
                PhoneSummary(6, "Passkey sign-in", "askeden", CodeStatus.NeedsYou, "edits", "Accept edits", "Sonnet 5.5", 0.61, today(5)),
                PhoneSummary(5, "Fix share-sheet crash", "askeden", CodeStatus.Working, "ask", "Manual", "Opus 5.5", 1.42, today(12)),
                PhoneSummary(7, "Chat list redesign", "eden messenger", CodeStatus.Done, model = "Opus 5.5", costUSD = 2.10, updatedAt = today(40)),
                PhoneSummary(8, "VoiceOver labels", "eden messenger", CodeStatus.Working, model = "Sonnet 5.5", costUSD = 0.20, updatedAt = today(55)),
                PhoneSummary(4, "No-zoom lock for iPad", "askeden", CodeStatus.Done, model = "Sonnet 5.5", costUSD = 0.38, updatedAt = daysAgo(1)),
                PhoneSummary(9, "Router log cleanup", "jarvis", CodeStatus.Done, model = "Haiku 5", costUSD = 0.05, updatedAt = daysAgo(1)),
                PhoneSummary(3, "README refresh", "jarvis", CodeStatus.Done, model = "Haiku 5", costUSD = 0.02, updatedAt = daysAgo(3)),
                PhoneSummary(10, "Windows installer check", "jarvis", CodeStatus.Done, model = "Sonnet 5.5", costUSD = 0.44, updatedAt = daysAgo(6)),
            ),
            attention = listOf(migrationCard, questionCard),
        )

    val optionsNow = PhoneOptions(
        models = listOf(
            PhoneOptions.Model("claude:opus", "Opus 5.5", "Claude"), PhoneOptions.Model("claude:sonnet", "Sonnet 5.5", "Claude"),
            PhoneOptions.Model("claude:haiku", "Haiku 5", "Claude"), PhoneOptions.Model("gemini:pro", "Gemini 3 Pro", "Gemini", needsKey = true),
        ),
        projects = listOf(
            PhoneOptions.Project("askeden / site", "main", 2), PhoneOptions.Project("eden messenger", "redesign", 0),
            PhoneOptions.Project("jarvis", "eden-code-hardening", 0),
        ),
        defaultModel = "claude:opus",
    )

    val usageNow = PhoneUsage(
        4.51, 20.0, (1..7).map { PhoneUsage.Day("2026-10-${9 + it}", it * 0.9) },
        listOf(PhoneUsage.Window("five_hour", 38.0), PhoneUsage.Window("seven_day", 61.0)),
    )

    val todosNow = PhoneTodos(
        listOf(
            PhoneTodoCard("t1", "askeden / site", "Dark mode for the pricing page", "Add a dark mode to /pricing", mode = "edits"),
            PhoneTodoCard("t2", "askeden / site", "Lighthouse to 95+", "Raise the Lighthouse score", mode = "ask", state = "queued"),
            PhoneTodoCard("t3", "eden messenger", "Rewrite the build scripts", "Move the build to Bun", mode = "auto"),
            PhoneTodoCard("t4", "eden messenger", "Typing indicator", "Show who is typing", mode = "ask", state = "started", taskID = 3),
        ),
    )

    fun view(id: Int): PhoneView {
        val summary = homeNow.sessions.firstOrNull { it.id == id }
        val status = summary?.status ?: CodeStatus.Working
        // The GChat mockup's conversation (and GAsk's for the passkey session).
        val entries = if (id == 6) mutableListOf(
            PhoneEntry(1, PhoneEntry.Role.User, "Add passkey sign-in to the site."),
            PhoneEntry(2, PhoneEntry.Role.Assistant, "Done with the code. The last step is the database: I need to add one table for passkeys."),
            PhoneEntry(3, PhoneEntry.Role.Tool, "Wrote the sign-in flow"),
            PhoneEntry(4, PhoneEntry.Role.Tool, "24 tests passed"),
        ) else mutableListOf(
            PhoneEntry(1, PhoneEntry.Role.User, "The share sheet crashes when I share a chat with a photo. Fix it and prove it in the simulator."),
            PhoneEntry(2, PhoneEntry.Role.Assistant, "On it. I reproduced the crash: the photo goes to the share sheet before its upload finishes, so the link is empty."),
            PhoneEntry(3, PhoneEntry.Role.Tool, "Read share.js and ShareSheet.swift"),
            PhoneEntry(4, PhoneEntry.Role.Tool, "Reproduced it in the iPhone simulator"),
            PhoneEntry(5, PhoneEntry.Role.Tool, "Fixed it in 2 files"),
            PhoneEntry(6, PhoneEntry.Role.Assistant, "Now it waits for the upload and falls back to the photo on the phone. Running the tests to make sure nothing else broke."),
        )
        if (status == CodeStatus.Working) entries += PhoneEntry(7, PhoneEntry.Role.Tool, "Running tests · 3 of 41…")
        val mode = summary?.mode ?: "ask"
        return PhoneView(
            id = id, title = summary?.title ?: "Fix share-sheet crash", project = summary?.project ?: "askeden / site", status = status,
            doing = if (status == CodeStatus.Working) "Running tests · 3 of 41" else "", mode = mode, modeLabel = CodeModes.name(mode),
            model = "claude:opus", modelLabel = summary?.model ?: "Opus 5.5", cards = homeNow.attention.filter { it.taskID == id },
            next = entries.last().i, v = "fixture", entries = entries,
        )
    }

    val changesNow: PhoneChanges
        @Synchronized get() = PhoneChanges(
            5, files = listOf(
                PhoneChanges.File(
                    "web/chat/share.js", added = 14, removed = 3, hunks = listOf(
                        PhoneChanges.Hunk(
                            "h1", 1, 41, 41, "async function share()", PhoneChanges.Line.number(
                                listOf(
                                    listOf("-", "const url = chat.image?.remoteUrl;"),
                                    listOf("+", "const img = await chat.image?.uploaded();"),
                                    listOf("+", "const url = img?.remoteUrl ?? img?.localFile;"),
                                ), 41, 41,
                            ), kept = "h1" in kept,
                        ),
                    ),
                ),
                PhoneChanges.File(
                    "ios/ShareSheet.swift", added = 6, removed = 1, hunks = listOf(
                        PhoneChanges.Hunk("h3", 2, 12, 12, lines = PhoneChanges.Line.number(listOf(listOf("+", "guard let url else { return shareText() }")), 12, 12), kept = "h3" in kept),
                    ),
                ),
            ),
        )

    override fun home() = homeNow
    override fun options() = optionsNow
    override fun session(id: Int, after: Int, seen: Long, v: String, wait: Int): PhoneView {
        if (v == "fixture") Thread.sleep(wait * 1000L)
        val view = view(id)
        return if (after > 0) view.copy(entries = view.entries.filter { it.i > after }) else view
    }
    override fun send(id: Int, text: String) = PhoneOK(true)
    override fun send(id: Int, text: String, pictures: List<Picture>) = PhoneOK(true)
    override fun steer(id: Int, text: String) = PhoneOK(true, steered = true)
    override fun stop(id: Int) = PhoneOK(true)
    override fun answer(card: String, choice: String, feedback: String?) = PhoneOK(true)
    override fun setMode(id: Int, mode: String) = PhoneOK(true)
    override fun setModel(id: Int, ref: String) = PhoneOK(true)
    override fun newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Boolean?) = PhoneOK(true, id = 5)
    override fun land(id: Int) = PhoneOK(true, "Confirm on its card.")
    override fun discard(id: Int) = PhoneOK(true, "Confirm on its card.")
    override fun unpin() = PhoneOK(true)
    override fun changes(id: Int, view: String) = changesNow
    override fun hunk(id: Int, hunks: List<String>, action: String, view: String): PhoneHunkResult {
        synchronized(this) { for (h in hunks) if (action == "keep") kept += h else kept -= h }
        return PhoneHunkResult(true, "", changesNow)
    }
    override fun comment(id: Int, comments: List<PhoneComment>) = PhoneOK(true)
    override fun receipts(id: Int) = PhoneReceipts(if (id == 6) emptyList() else listOf(receipt))
    override fun todos() = todosNow
    override fun startTodo(card: String) = PhoneOK(true, id = 5)
    override fun usage() = usageNow
    override fun openPullRequest(id: Int) = PhoneOK(true, "Opened a draft pull request.")
}
