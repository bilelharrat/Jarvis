#if DEBUG
import Foundation

/// Debug-build-only launch arguments (the companion's DebugLaunch pattern), e.g.
///
///     xcrun simctl launch <device> com.askeden.jarvis.edencode -EDENCODEFixtures YES -EDENCODEOpen session:5
///
/// -EDENCODEFixtures YES: sample sessions instead of a Mac (to look at the screens).
/// -EDENCODEOpen session:<id> | changes:<id> | approve | inbox | queue | settings | new | pair
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

    var homeNow: PhoneHome {
        PhoneHome(
            sessions: [
                PhoneSummary(id: 5, title: "Fix share-sheet crash", project: "askeden / site", status: .working, mode: "ask",
                             modeLabel: "Manual", model: "Opus 5.5", costUSD: 1.42),
                PhoneSummary(id: 6, title: "Passkey sign-in", project: "askeden / site", status: .needsYou, mode: "edits",
                             modeLabel: "Accept edits", model: "Sonnet 5.5", costUSD: 0.61),
                PhoneSummary(id: 4, title: "No-zoom lock for iPad", project: "askeden / site", status: .done, model: "Sonnet 5.5", costUSD: 0.38),
                PhoneSummary(id: 3, title: "Redesign the chat list", project: "eden messenger", status: .failed, model: "Opus 5.5", costUSD: 2.10),
            ],
            attention: [Self.migrationCard, Self.questionCard],
            pinned: nil,
            exterminator: []
        )
    }

    static let migrationCard = PhoneCard(
        approval: Approval(id: "c-migrate", question: "Run a database migration?",
                           detail: "npx wrangler d1 migrations apply eden --remote",
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
            models: [PhoneOptions.Model(ref: "claude:opus", name: "Opus 5.5", group: "Claude"),
                     PhoneOptions.Model(ref: "claude:sonnet", name: "Sonnet 5.5", group: "Claude"),
                     PhoneOptions.Model(ref: "claude:haiku", name: "Haiku 5", group: "Claude"),
                     PhoneOptions.Model(ref: "gemini:pro", name: "Gemini 3 Pro", group: "Gemini", needsKey: true)],
            projects: [PhoneOptions.Project(name: "askeden / site", branch: "main", running: 2),
                       PhoneOptions.Project(name: "eden messenger", branch: "redesign", running: 0),
                       PhoneOptions.Project(name: "jarvis", branch: "eden-code-hardening", running: 0)],
            defaultModel: "claude:opus")
    }

    var usageNow: PhoneUsage {
        PhoneUsage(today: 4.51, dayCap: 20, recent: (1...7).map { PhoneUsage.Day(day: "2026-10-\(9 + $0)", total: Double($0) * 0.9) },
                   windows: [PhoneUsage.Window(kind: "five_hour", percent: 38), PhoneUsage.Window(kind: "seven_day", percent: 61)])
    }

    var todosNow: PhoneTodos {
        PhoneTodos(cards: [
            PhoneTodoCard(id: "t1", project: "askeden / site", title: "Dark mode for the pricing page", prompt: "Add a dark mode to /pricing", mode: "edits"),
            PhoneTodoCard(id: "t2", project: "askeden / site", title: "Lighthouse to 95+", prompt: "Raise the Lighthouse score", mode: "ask", state: "queued"),
            PhoneTodoCard(id: "t3", project: "eden messenger", title: "Rewrite the build scripts", prompt: "Move the build to Bun", mode: "auto"),
            PhoneTodoCard(id: "t4", project: "eden messenger", title: "Typing indicator", prompt: "Show who is typing", mode: "ask", state: "started", taskID: 3),
        ])
    }

    func view(_ id: Int) -> PhoneView {
        var v = PhoneView(id: id)
        let summary = homeNow.sessions.first { $0.id == id }
        v.title = summary?.title ?? "Fix share-sheet crash"
        v.project = summary?.project ?? "askeden / site"
        v.status = summary?.status ?? .working
        v.mode = summary?.mode ?? "ask"
        v.modeLabel = CodeModes.name(v.mode)
        v.model = "claude:opus"
        v.modelLabel = summary?.model ?? "Opus 5.5"
        v.doing = v.status == .working ? "Running tests · 3 of 41" : ""
        v.entries = [
            PhoneEntry(i: 1, role: .user, text: "The share sheet crashes with an image. Fix it and prove it in the simulator."),
            PhoneEntry(i: 2, role: .tool, text: "Read share.js, ShareSheet.swift +4"),
            PhoneEntry(i: 3, role: .tool, text: "Reproduced in iPhone 17 simulator"),
            PhoneEntry(i: 4, role: .tool, text: "Edited 2 files"),
            PhoneEntry(i: 5, role: .assistant, text: "Found it: the image goes to the share sheet before its upload finishes. I now wait for the upload and fall back to the local file."),
        ]
        if v.status == .working { v.entries.append(PhoneEntry(i: 6, role: .tool, text: "Running tests · 3 of 41…")) }
        v.cards = homeNow.attention.filter { $0.taskID == id }
        v.next = v.entries.last?.i ?? 0
        v.v = "fixture"
        return v
    }

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
    func receipts(id: Int) async throws -> PhoneReceipts { PhoneReceipts(receipts: [Self.receipt]) }
    func todos() async throws -> PhoneTodos { todosNow }
    func startTodo(card: String) async throws -> PhoneOK { PhoneOK(ok: true, id: 5) }
    func usage() async throws -> PhoneUsage { usageNow }
    func openPullRequest(id: Int) async throws -> PhoneOK { PhoneOK(ok: true, said: "Opened a draft pull request.") }
}
#endif
