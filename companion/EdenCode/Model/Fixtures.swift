#if DEBUG
import Foundation

/// Debug-build-only launch arguments (the companion's DebugLaunch pattern), e.g.
///
///     xcrun simctl launch <device> com.askeden.jarvis.edencode -EDENCODEFixtures YES -EDENCODEOpen session:5
///
/// -EDENCODEFixtures YES: sample sessions instead of a Mac (to look at the screens).
/// -EDENCODEOpen session:<id> | changes:<id> | approve | drawer | inbox | queue | settings | new | pair
/// -EDENCODEServer host:port -EDENCODECode 123456: pairs with a test Mac at launch.
/// -EDENCODEReset YES: forgets every paired Mac.
/// None of this exists in Release builds.
enum EdenDebug {
    private static var defaults: UserDefaults { .standard }
    static var fixtures: Bool { defaults.bool(forKey: "EDENCODEFixtures") }
    static var open: String? { defaults.string(forKey: "EDENCODEOpen") }
    static var server: String? { defaults.string(forKey: "EDENCODEServer") }
    static var code: String? { defaults.string(forKey: "EDENCODECode") }
    static var reset: Bool { defaults.bool(forKey: "EDENCODEReset") }
    static var typed: String? { defaults.string(forKey: "EDENCODETyped") }
    static var composerOpen: Bool { defaults.bool(forKey: "EDENCODEComposerOpen") }
    static var focus: Bool { defaults.bool(forKey: "EDENCODEFocus") }
    /// -EDENCODEModels YES: the model list open over the input bar (for screenshots).
    static var models: Bool { defaults.bool(forKey: "EDENCODEModels") }
}

/// Sample data for every screen, as a Mac would answer it.
final class FixtureBackend: CodeBackend, @unchecked Sendable {
    static let shared = FixtureBackend()

    static let macs: [Pairing] = [
        Pairing(baseURL: URL(string: "https://macbook-air.local:8765")!, token: "fixture", macName: "MacBook Air",
                deviceName: "iPhone", pairedAt: Date(), fingerprint: String(repeating: "ab", count: 32)),
        Pairing(baseURL: URL(string: "https://studio.local:8765")!, token: "fixture", macName: "Mac Studio",
                deviceName: "iPhone", pairedAt: Date(), fingerprint: String(repeating: "cd", count: 32)),
    ]

    private let lock = NSLock()
    private var kept: Set<String> = ["h3"]

    /// The G mockups' sessions (GDrawer.dc.html): one waits on the owner, two work, the rest
    /// are done today, yesterday and earlier.
    var homeNow: PhoneHome {
        let now = Date()
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now) ?? ago(1440)
        return PhoneHome(
            sessions: [
                PhoneSummary(id: 5, title: "Fix share-sheet crash", project: "askeden", status: .working, mode: "ask",
                             modeLabel: "Manual", model: "Opus 5.5", costUSD: 1.42, updatedAt: ago(2)),
                PhoneSummary(id: 6, title: "Passkey sign-in", project: "askeden", status: .needsYou, mode: "edits",
                             modeLabel: "Accept edits", model: "Sonnet 5.5", costUSD: 0.61, updatedAt: ago(9)),
                PhoneSummary(id: 4, title: "Chat list redesign", project: "eden messenger", status: .done, model: "Sonnet 5.5", costUSD: 0.38, updatedAt: ago(25)),
                // A long one at rest (the owner's TestFlight 2 screenshots): it scrolls under the
                // header and must end above the input bar; the drawer says "Resting", not "Waiting".
                PhoneSummary(id: 11, title: "Resume after restart", project: "jarvis", status: .resting, model: "Model Router",
                             costUSD: 0.84, updatedAt: ago(70)),
                PhoneSummary(id: 7, title: "VoiceOver labels", project: "askeden", status: .working, model: "Opus 5.5", costUSD: 0.20, updatedAt: ago(40)),
                PhoneSummary(id: 3, title: "No-zoom lock for iPad", project: "askeden", status: .done, model: "Sonnet 5.5", costUSD: 0.52, updatedAt: yesterday),
                PhoneSummary(id: 8, title: "Router log cleanup", project: "jarvis", status: .done, model: "Haiku 5", costUSD: 0.09, updatedAt: yesterday.addingTimeInterval(-3600)),
                PhoneSummary(id: 9, title: "README refresh", project: "jarvis", status: .done, model: "Haiku 5", costUSD: 0.05, updatedAt: ago(60 * 24 * 3)),
                PhoneSummary(id: 10, title: "Windows installer check", project: "jarvis", status: .failed, model: "Opus 5.5", costUSD: 2.10, updatedAt: ago(60 * 24 * 6)),
            ],
            attention: [Self.migrationCard, Self.questionCard],
            pinned: nil,
            exterminator: []
        )
    }

    static let migrationCard = PhoneCard(
        approval: Approval(id: "c-migrate", question: "Can I add the passkeys table?",
                           detail: "wrangler d1 migrations apply eden --remote",
                           choices: [ApprovalChoice(id: "allow", label: "Allow"), ApprovalChoice(id: "always", label: "Always allow migrations in this project"),
                                     ApprovalChoice(id: "deny", label: "Deny")],
                           source: .code, taskID: 6),
        faceID: true, tool: "Bash")

    static var questionCard: PhoneCard {
        var approval = Approval(id: "c-question", question: "Which sign-in should the button use?",
                                detail: "", choices: [ApprovalChoice(id: "opt0", label: "Passkey first"), ApprovalChoice(id: "opt1", label: "Email link first"),
                                                      ApprovalChoice(id: "deny", label: "Skip")], source: .code, taskID: 6)
        approval.askKind = "question"
        return PhoneCard(approval: approval, tool: "AskUserQuestion")
    }

    var optionsNow: PhoneOptions {
        PhoneOptions(
            // As a Mac answers (docs/eden-code-phone.md): Model Router first, then the Mac's
            // headings; the Moonshot rows as an older Mac sent them, raw ids and its provider's name.
            models: [PhoneOptions.Model(ref: "router", name: "Model Router", note: "Picks the model and effort for each message", router: true),
                     PhoneOptions.Model(ref: "claude:opus", name: "Claude Opus 5.5", group: "Anthropic Claude"),
                     PhoneOptions.Model(ref: "claude:sonnet", name: "Claude Sonnet 5.5", group: "Anthropic Claude"),
                     PhoneOptions.Model(ref: "custom:gpt", name: "GPT-6.1 Sol", group: "OpenAI GPT"),
                     PhoneOptions.Model(ref: "eden:gemini-4-argon", name: "Gemini 4 Argon", group: "Google Gemini", needsKey: true,
                                        note: "Needs a Google Gemini API key"),
                     PhoneOptions.Model(ref: "custom:k26", name: ModelMenu.friendly("kimi-k2.6"), group: "Moonshot"),
                     PhoneOptions.Model(ref: "custom:k27", name: ModelMenu.friendly("kimi-k2.7-code"), group: "Moonshot"),
                     PhoneOptions.Model(ref: "custom:k27h", name: ModelMenu.friendly("kimi-k2.7-code-highspeed"), group: "Moonshot"),
                     PhoneOptions.Model(ref: "custom:qwen", name: "Qwen3", group: "On this Mac")],
            projects: [PhoneOptions.Project(name: "askeden", branch: "main", running: 2),
                       PhoneOptions.Project(name: "eden messenger", branch: "redesign", running: 0),
                       PhoneOptions.Project(name: "jarvis", branch: "eden-code-hardening", running: 1)],
            defaultModel: "claude:opus")
    }

    var usageNow: PhoneUsage {
        PhoneUsage(today: 4.51, dayCap: 20, recent: (1...7).map { PhoneUsage.Day(day: "2026-10-\(9 + $0)", total: Double($0) * 0.9) },
                   windows: [PhoneUsage.Window(kind: "five_hour", percent: 38), PhoneUsage.Window(kind: "seven_day", percent: 61)])
    }

    var todosNow: PhoneTodos {
        PhoneTodos(cards: [
            PhoneTodoCard(id: "t1", project: "askeden", title: "Dark mode for the pricing page", prompt: "Add a dark mode to /pricing", mode: "edits"),
            PhoneTodoCard(id: "t2", project: "askeden", title: "Lighthouse to 95+", prompt: "Raise the Lighthouse score", mode: "ask", state: "queued"),
            PhoneTodoCard(id: "t3", project: "eden messenger", title: "Rewrite the build scripts", prompt: "Move the build to Bun", mode: "auto"),
            PhoneTodoCard(id: "t4", project: "eden messenger", title: "Typing indicator", prompt: "Show who is typing", mode: "ask", state: "started", taskID: 3),
        ])
    }

    func view(_ id: Int) -> PhoneView {
        var v = PhoneView(id: id)
        let summary = homeNow.sessions.first { $0.id == id }
        v.title = summary?.title ?? "Fix share-sheet crash"
        v.project = summary?.project ?? "askeden"
        v.status = summary?.status ?? .working
        v.mode = summary?.mode ?? "ask"
        v.modeLabel = CodeModes.name(v.mode)
        v.model = "claude:opus"
        v.modelLabel = summary?.model ?? "Opus 5.5"
        v.doing = v.status == .working ? "Running tests · 3 of 41" : ""
        if id == 11 {
            v.model = "router"
            v.modelLabel = "Model Router"
            v.router = true
            v.routedLabel = "Claude Sonnet 5.5"
            v.entries = Self.longTranscript
        } else if id == 6 {
            // GAsk.dc.html
            v.entries = [
                PhoneEntry(i: 1, role: .user, text: "Add passkey sign-in to the site."),
                PhoneEntry(i: 2, role: .assistant, text: "Done with the code. The last step is the database: I need to add one table for passkeys."),
                PhoneEntry(i: 3, role: .tool, text: "Wrote the sign-in flow"),
                PhoneEntry(i: 4, role: .tool, text: "24 tests passed"),
            ]
        } else {
            // GChat.dc.html
            v.entries = [
                PhoneEntry(i: 1, role: .user, text: "The share sheet crashes when I share a chat with a photo. Fix it and prove it in the simulator."),
                PhoneEntry(i: 2, role: .assistant, text: "On it. I reproduced the crash: the photo goes to the share sheet before its upload finishes, so the link is empty."),
                PhoneEntry(i: 3, role: .tool, text: "Read share.js and ShareSheet.swift"),
                PhoneEntry(i: 4, role: .tool, text: "Reproduced it in the iPhone simulator"),
                PhoneEntry(i: 5, role: .tool, text: "Fixed it in 2 files"),
                PhoneEntry(i: 6, role: .assistant, text: "Now it waits for the upload and falls back to the photo on the phone. Running the tests to make sure nothing else broke."),
            ]
            if v.status == .working { v.entries.append(PhoneEntry(i: 7, role: .tool, text: "Running tests · 3 of 41…")) }
        }
        v.cards = homeNow.attention.filter { $0.taskID == id }
        v.next = v.entries.last?.i ?? 0
        v.v = "fixture"
        return v
    }

    /// The owner's screenshot's session, long enough to scroll.
    static let longTranscript: [PhoneEntry] = {
        var out = [
            PhoneEntry(i: 1, role: .user, text: "Pick up where we left off before the restart."),
            PhoneEntry(i: 2, role: .assistant, text: "Hi Bilel, I'm back. Reading the to-do list and the last session's notes first so I don't redo anything."),
            PhoneEntry(i: 3, role: .tool, text: "Reading TODO.md"),
            PhoneEntry(i: 4, role: .tool, text: "Read ROADMAP.md"),
        ]
        let lines = ["The installer check passed on the Windows runner.", "The phone's pairing sheet now scans the QR code.",
                     "Two tests were flaky; I made them wait for the server instead of sleeping.", "The receipts screen loads the last five turns."]
        for (n, line) in lines.enumerated() {
            out.append(PhoneEntry(i: 5 + n * 2, role: .assistant, text: line))
            out.append(PhoneEntry(i: 6 + n * 2, role: .tool, text: "Ran the tests (\(40 + n) passed)"))
        }
        out.append(PhoneEntry(i: 20, role: .user, text: "And after a restart?"))
        out.append(PhoneEntry(i: 21, role: .assistant, text: "Back after the restart: it picks up where it left off, with the same session, the same model and the queue as it was."))
        return out
    }()

    var changesNow: PhoneChanges {
        lock.withLock {
            PhoneChanges(id: 5, files: [
                PhoneChanges.File(path: "web/chat/share.js", added: 14, removed: 3, hunks: [
                    PhoneChanges.Hunk(id: "h1", n: 1, newStart: 41, oldStart: 41, header: "async function share()", lines: PhoneChanges.Line.number([
                        ["-", "const url = chat.image?.remoteUrl;"],
                        ["+", "const img = await chat.image?.uploaded();"],
                        ["+", "const url = img?.remoteUrl ?? img?.localFile;"],
                    ], oldStart: 41, newStart: 41), kept: kept.contains("h1")),
                ]),
                PhoneChanges.File(path: "ios/ShareSheet.swift", added: 6, removed: 1, hunks: [
                    PhoneChanges.Hunk(id: "h3", n: 2, newStart: 12, oldStart: 12, lines: PhoneChanges.Line.number([
                        ["+", "guard let url else { return shareText() }"],
                    ], oldStart: 12, newStart: 12), kept: kept.contains("h3")),
                ]),
            ])
        }
    }

    static let receipt = PhoneReceipt(i: 7, text: "Proof · Changed 2 files · tests passed (41)", risk: "low", why: "small, tested change", fileCount: 2, rows: [
        .init(mark: .good, text: "41 tests passed"), .init(mark: .good, text: "7 of 9 mutants caught"),
        .init(mark: .good, text: "Security scan clean"), .init(mark: .good, text: "Checked in simulator"),
        .init(mark: .warn, text: "1 assumption"), .init(mark: .good, text: "Guardrails held"),
    ])

    // MARK: - CodeBackend

    func home() async throws -> PhoneHome { homeNow }
    func options() async throws -> PhoneOptions { optionsNow }
    func session(id: Int, after: Int, seen: Int, v: String, wait: Int) async throws -> PhoneView {
        if v == "fixture" { try await Task.sleep(for: .seconds(wait)) }
        var view = view(id)
        if after > 0 { view.entries = view.entries.filter { $0.i > after } }
        return view
    }
    func send(id: Int, text: String) async throws -> PhoneOK { PhoneOK(ok: true) }
    func send(id: Int, text: String, pictures: [CodeAttachment]) async throws -> PhoneOK { PhoneOK(ok: true) }
    func steer(id: Int, text: String) async throws -> PhoneOK { PhoneOK(ok: true, steered: true) }
    func stop(id: Int) async throws -> PhoneOK { PhoneOK(ok: true) }
    func answer(card: String, choice: String, feedback: String?) async throws -> PhoneOK { PhoneOK(ok: true) }
    func setMode(id: Int, mode: String) async throws -> PhoneOK { PhoneOK(ok: true) }
    func setModel(id: Int, ref: String) async throws -> PhoneOK { PhoneOK(ok: true) }
    func newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Bool?) async throws -> PhoneOK { PhoneOK(ok: true, id: 5) }
    func land(id: Int) async throws -> PhoneOK { PhoneOK(ok: true, said: "Confirm on its card.") }
    func discard(id: Int) async throws -> PhoneOK { PhoneOK(ok: true, said: "Confirm on its card.") }
    func unpin() async throws -> PhoneOK { PhoneOK(ok: true) }
    func changes(id: Int, view: String) async throws -> PhoneChanges { changesNow }
    func hunk(id: Int, hunks: [String], action: String, view: String) async throws -> PhoneHunkResult {
        lock.withLock {
            for hunk in hunks {
                if action == "keep" { kept.insert(hunk) } else { kept.remove(hunk) }
            }
        }
        let data = try JSONEncoder().encode(["ok": true])
        var result = try JSONDecoder().decode(PhoneHunkResult.self, from: data)
        result.changes = changesNow
        return result
    }
    func comment(id: Int, comments: [PhoneComment]) async throws -> PhoneOK { PhoneOK(ok: true) }
    func receipts(id: Int) async throws -> PhoneReceipts { PhoneReceipts(receipts: id == 5 ? [Self.receipt] : []) }
    func todos() async throws -> PhoneTodos { todosNow }
    func startTodo(card: String) async throws -> PhoneOK { PhoneOK(ok: true, id: 5) }
    func usage() async throws -> PhoneUsage { usageNow }
    func openPullRequest(id: Int) async throws -> PhoneOK { PhoneOK(ok: true, said: "Opened a draft pull request.") }
}
#endif
