import XCTest
@testable import EdenCode

/// The phone API's answers as the Mac sends them (features/code_phone.py and
/// _code_phone_routes.py), decoded leniently; the long poll's bookkeeping; what each composer
/// action calls; and the small rules the screens rely on.
final class PhoneAPITests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try LiveBackend.decode(T.self, Data(json.utf8))
    }

    func testHomeGroupsSessionsAndReadsCardsAndThePin() throws {
        let home = try decode(PhoneHome.self, """
        {"sessions": [
          {"id": 5, "title": "Fix share-sheet crash", "project": "site", "status": "working", "mode": "ask",
           "mode_label": "Manual", "model": "Opus 5.5", "cost_usd": 1.5, "updated_at": "2026-10-16T10:00:00"},
          {"id": 6, "title": "", "project": "site", "status": "needs_you", "mode": "edits", "cost_usd": null},
          {"id": "7", "title": "Chat list", "project": "messenger", "status": "weird"},
          {"title": "no id"}
        ],
         "attention": [{"id": "c1", "question": "Run a command?", "detail": "$ npm test", "choices": [
            {"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}], "source": "code", "task_id": 6,
            "mac_only": false, "tool": "Bash", "face_id": true},
           {"id": "c2", "question": "Land it?", "choices": [{"id": "allow", "label": "Land"}, {"id": "deny", "label": "No"}],
            "task_id": 5, "mac_only": true, "copy": "fix-share"}],
         "pinned": {"id": 5, "title": "Fix share-sheet crash", "at": 1760600000000},
         "exterminator": [{"id": "r1", "project": "site", "state": "running", "round": 2, "rounds": 3, "step": "fix",
            "spent": 1.5, "spend_cap": 10, "task_id": 9, "found": 4, "fixed": 1, "open": 3, "landed": false}]}
        """)
        XCTAssertEqual(home.sessions.map(\.id), [5, 6, 7])  // the one without an id is skipped
        XCTAssertEqual(home.sessions[1].title, "site")  // no title: its project
        XCTAssertEqual(home.sessions[1].modeLabel, "Accept edits")
        XCTAssertEqual(home.sessions[2].status, .unknown)
        XCTAssertNotNil(home.sessions[0].updatedAt)
        XCTAssertEqual(home.byProject.map(\.project), ["site", "messenger"])
        XCTAssertEqual(home.attention.count, 2)
        XCTAssertTrue(home.attention[0].faceID)
        XCTAssertEqual(home.attention[0].tool, "Bash")
        XCTAssertTrue(home.attention[1].macOnly)
        XCTAssertEqual(home.attention[1].copy, "fix-share")
        XCTAssertEqual(home.pinned?.id, 5)
        XCTAssertEqual(home.needsYouCount, 2)
        XCTAssertEqual(home.exterminator.first?.line, "Round 2 of 3 · fix · 4 found, 1 fixed · $1.50 of $10.00")
    }

    func testFaceIDIsAskedForCommandsAndStandingAnswersOnly() throws {
        let card = try decode(PhoneCard.self, """
        {"id": "c3", "question": "Fetch a page?", "task_id": 5, "tool": "WebFetch", "face_id": false,
         "choices": [{"id": "allow", "label": "Allow"}, {"id": "always", "label": "Always allow"}, {"id": "deny", "label": "Deny"}]}
        """)
        let allow = card.approval.choices[0], always = card.approval.choices[1], deny = card.approval.choices[2]
        XCTAssertFalse(card.needsFaceID(allow))
        XCTAssertTrue(card.needsFaceID(always))
        XCTAssertFalse(card.needsFaceID(deny))
        XCTAssertEqual(card.noChoice.id, "deny")
        XCTAssertEqual(card.yesChoices.map(\.id), ["allow", "always"])
        // An older Mac that doesn't say: a Bash card still asks.
        let older = try decode(PhoneCard.self, #"{"id": "c4", "question": "Run?", "tool": "Bash", "choices": []}"#)
        XCTAssertTrue(older.needsFaceID(older.approval.primary))
    }

    func testOptionsDefaultToThePhonesTwoModes() throws {
        let options = try decode(PhoneOptions.self, """
        {"models": [{"ref": "claude:opus", "name": "Opus 5.5", "group": "Claude", "needs_key": false},
                    {"ref": "gemini:pro", "name": "Gemini", "needs_key": true}, {"name": "no ref"}],
         "projects": [{"name": "site", "branch": "main", "running": 2}],
         "defaults": {"model": "claude:opus", "mode": "edits"}}
        """)
        XCTAssertEqual(options.models.map(\.ref), ["claude:opus", "gemini:pro"])
        XCTAssertTrue(options.models[1].needsKey)
        XCTAssertEqual(options.modes.map(\.id), ["ask", "edits"])  // none sent: the phone's own
        XCTAssertEqual(options.defaultMode, "edits")
        XCTAssertEqual(options.projects.first?.running, 2)
        XCTAssertEqual(options.modelName("claude:opus"), "Opus 5.5")
    }

    func testTheLongPollAppendsNewEntriesAndReplacesChangedOnes() async throws {
        let first = try decode(PhoneView.self, """
        {"id": 5, "title": "Fix it", "project": "site", "status": "working", "doing": "Running tests", "mode": "ask",
         "mode_label": "Manual", "model": "claude:opus", "model_label": "Opus 5.5", "live": "", "todos": [{"text": "a", "done": true}],
         "cards": [], "copy": null, "next": 2, "seen": 10, "v": "abc",
         "entries": [{"i": 1, "role": "user", "text": "fix it", "at": ""}, {"i": 2, "role": "tool", "text": "Bash npm test running…"}],
         "changed": [], "more": false}
        """)
        let later = try decode(PhoneView.self, """
        {"id": 5, "status": "done", "next": 3, "seen": 20, "v": "def", "live": "",
         "entries": [{"i": 3, "role": "assistant", "text": "Done."}],
         "changed": [{"i": 2, "role": "tool", "text": "Bash npm test → 41 passed"}]}
        """)
        let model = await SessionModel(id: 5, backend: Recorder())
        await model.apply(first)
        await model.apply(later)
        let entries = await model.entries
        XCTAssertEqual(entries.map(\.i), [1, 2, 3])
        XCTAssertEqual(entries[1].text, "Bash npm test → 41 passed")
        let view = await model.view
        XCTAssertEqual(view.next, 3)
        XCTAssertEqual(view.seen, 20)
        XCTAssertEqual(view.v, "def")
        XCTAssertTrue(view.entries.isEmpty)  // kept in entries, not twice
        let line = await model.statusLine
        XCTAssertEqual(line, "Finished")
    }

    func testRowsGroupStepsBetweenTheWords() {
        let rows = SessionModel.rows([
            PhoneEntry(i: 1, role: .user, text: "go"),
            PhoneEntry(i: 2, role: .tool, text: "Read a.py"),
            PhoneEntry(i: 3, role: .tool, text: "Edited 2 files"),
            PhoneEntry(i: 4, role: .assistant, text: "Done"),
            PhoneEntry(i: 5, role: .note, text: "Proof · …"),
        ])
        XCTAssertEqual(rows.map(\.id), ["u1", "s2", "r4", "n5"])
        if case .steps(let steps) = rows[1] { XCTAssertEqual(steps.count, 2) } else { XCTFail("steps") }
        XCTAssertEqual(PhoneEntry(i: 9, role: .tool, text: "Read share.js\n  12 lines").stepLine, "Read share.js")
    }

    func testTheComposerSendsSteersOrQueues() async throws {
        let recorder = Recorder()
        let model = await SessionModel(id: 5, backend: recorder)
        var view = PhoneView(id: 5)
        view.status = .working
        await model.apply(view)
        let steered = await model.send("use the other API", steer: true)
        let queued = await model.send("then the docs", steer: false)
        let blank = await model.send("   ", steer: false)
        XCTAssertTrue(steered && queued)
        XCTAssertFalse(blank)
        let calls = await recorder.calls
        XCTAssertEqual(calls, ["steer 5 use the other API", "send 5 then the docs"])
        // Not working: a steer is just a message.
        view.status = .done
        await model.apply(view)
        _ = await model.send("again", steer: true)
        let after = await recorder.calls
        XCTAssertEqual(after.last, "send 5 again")
    }

    func testChangesNumberLinesForComments() throws {
        let changes = try decode(PhoneChanges.self, """
        {"id": 5, "view": "turn", "git": true, "files": [{"path": "a.py", "status": "M", "binary": false, "sensitive": false,
          "added": 2, "removed": 1, "omitted": false, "hunks": [{"id": "h1", "n": 1, "old_start": 4, "old_count": 3,
          "new_start": 4, "new_count": 4, "header": "", "where": "def f", "line": 5,
          "lines": [[" ", "a"], ["-", "b"], ["+", "B"], ["+", "C"], ["\\\\", "No newline"], [" ", "d"]], "cut": 0, "kept": false}]}],
         "totals": {"files": 1, "added": 2, "removed": 1, "hunks": 1}}
        """)
        let lines = changes.files[0].hunks[0].lines
        XCTAssertEqual(lines.map(\.number), [4, 5, 5, 6, 7])
        XCTAssertEqual(lines.map(\.kind), [.context, .removed, .added, .added, .context])
        XCTAssertEqual(changes.unkeptHunks, ["h1"])
        XCTAssertEqual(changes.totalHunks, 1)
        let comment = PhoneComment(path: "a.py", line: lines[1].number, side: "o", excerpt: "b", text: "keep it")
        XCTAssertEqual(comment.json, ["path": "a.py", "line": 5, "side": "o", "excerpt": "b", "text": "keep it"])
        let plain = PhoneComment(path: "a.py", line: 6, side: nil, excerpt: "C", text: "why?")
        XCTAssertNil(plain.json["side"])
    }

    func testReceiptsBecomeTheGrid() throws {
        let receipts = try decode(PhoneReceipts.self, """
        {"id": 5, "receipts": [{"i": 7, "at": "", "text": "Proof · …", "receipt": {
          "files": ["a.py", "b.py"], "file_count": 2, "risk": "medium", "why": "it changed code and ran no tests",
          "tests": {"passed": true, "passed_count": 41, "state": "passed"},
          "integrity": {"lines": [{"text": "7 of 9 mutants caught"}]},
          "check": {"status": "ok", "text": "Looks right"},
          "security": {"findings": []},
          "guardrails": [{"action": "flagged", "count": 1}],
          "assumptions": [{"question": "Use v2?", "risk": "low", "state": "open"}]}}]}
        """)
        let receipt = try XCTUnwrap(receipts.receipts.first)
        XCTAssertEqual(receipt.riskLabel, "Medium risk")
        XCTAssertEqual(receipt.fileCount, 2)
        XCTAssertEqual(receipt.rows.map(\.text), ["41 tests passed", "7 of 9 mutants caught", "Checked after the turn",
                                                  "Security scan clean", "Guardrails held", "1 assumption"])
        let failing = PhoneReceipt.rows(["tests": ["state": "failed", "failed_count": 3]])
        XCTAssertEqual(failing.first, PhoneReceipt.Row(mark: .bad, text: "3 tests failed"))
        XCTAssertEqual(PhoneReceipt.rows([:]).first?.text, "No tests run")
    }

    func testTodosUsageAndOK() throws {
        let todos = try decode(PhoneTodos.self, """
        {"cards": [{"id": "t1", "project": "site", "title": "Dark mode", "mode": "edits", "state": "todo", "task_id": null},
                   {"id": "t2", "project": "site", "title": "Build", "mode": "auto", "state": "todo"},
                   {"id": "t3", "project": "app", "title": "Chat", "state": "started", "task_id": 4}], "queues": {}}
        """)
        XCTAssertEqual(todos.byProject.map(\.project), ["site", "app"])
        XCTAssertFalse(todos.cards[0].startsOnMacOnly)
        XCTAssertTrue(todos.cards[1].startsOnMacOnly)
        XCTAssertEqual(todos.cards[2].taskID, 4)
        XCTAssertFalse(todos.cards[2].waiting)
        let usage = try decode(PhoneUsage.self, """
        {"today": 3.25, "day_cap": 20, "recent": [{"day": "2026-10-15", "total": 1.0, "turns": 2}, {"day": "2026-10-16", "total": 3.25}],
         "by_project": [], "windows": [{"kind": "seven_day", "utilization": 0.61}, {"kind": "five_hour", "percent": 42}]}
        """)
        XCTAssertEqual(usage.fiveHour?.percent, 42)
        XCTAssertEqual(usage.windows[0].percent ?? 0, 61, accuracy: 0.001)
        XCTAssertEqual(usage.week, 4.25, accuracy: 0.001)
        let ok = try decode(PhoneOK.self, #"{"ok": true, "id": 42}"#)
        XCTAssertEqual(ok.id, 42)
        XCTAssertTrue(try decode(PhoneOK.self, "{}").ok)
    }

    func testTheOffSwitchAndErrorsComeInTheOwnersWords() {
        let off = Data(#"{"error": "Turn on Eden Code on your phone in Eden Code › More › Hand off to phone first.", "off": true}"#.utf8)
        XCTAssertThrowsError(try JarvisAPI.check(status: 403, data: off)) { error in
            guard case JarvisError.rejected(let message) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(message.contains("Hand off to phone"))
        }
        XCTAssertThrowsError(try JarvisAPI.check(status: 404, data: Data(#"{"error": "No such session."}"#.utf8))) { error in
            XCTAssertEqual(error as? JarvisError, .gone("No such session."))
        }
        XCTAssertThrowsError(try LiveBackend.decode(PhoneHome.self, Data("<html>".utf8))) { error in
            XCTAssertEqual(error as? JarvisError, .notJarvis)
        }
    }

    func testMacsAreAddedReplacedAndRemoved() {
        let a = Pairing(baseURL: URL(string: "https://a.local:8765")!, token: "t1", pairedAt: Date(), fingerprint: String(repeating: "a", count: 64))
        var a2 = a
        a2.token = "t2"
        a2.baseURL = URL(string: "https://192.168.1.2:8765")!
        let b = Pairing(baseURL: URL(string: "https://b.local:8765")!, token: "t3", pairedAt: Date(), fingerprint: String(repeating: "b", count: 64))
        var macs = MacStore.adding(a, to: [])
        macs = MacStore.adding(b, to: macs)
        macs = MacStore.adding(a2, to: macs)  // the same certificate: replaced, in place
        XCTAssertEqual(macs.map(\.token), ["t2", "t3"])
        XCTAssertEqual(MacStore.removing(b, from: macs).map(\.token), ["t2"])
        XCTAssertEqual(MacStore.key(a), String(repeating: "a", count: 64))
    }

    @MainActor
    func testWordsForTheInbox() {
        let approval = PhoneCard(approval: Approval(id: "1", question: "Run?"))
        var question = Approval(id: "2", question: "Which?")
        question.askKind = "question"
        let asked = PhoneCard(approval: question)
        XCTAssertEqual(InboxView.summary([approval, asked]), "An approval and a question")
        XCTAssertEqual(InboxView.summary([approval, approval]), "2 approvals")
        XCTAssertEqual(InboxView.summary([asked]), "A question")
    }

    func testSpokenTextDropsMarksAndPaths() {
        XCTAssertEqual(Speaker.spoken("**Done.** Fixed `web/chat/share.js`\n\nAll good"), "Done. Fixed share.js. All good")
        let file = PhoneChanges.File(path: "web/a.js", added: 1, removed: 1, hunks: [
            PhoneChanges.Hunk(id: "h", n: 1, newStart: 3, lines: PhoneChanges.Line.number([["-", "x = 1"], ["+", "x = 2"]], oldStart: 3, newStart: 3)),
        ])
        XCTAssertEqual(Speaker.spoken(file: file), "In a.js, 1 added, 1 removed. Change 1, line 3. removed: x = 1. added: x = 2")
    }
}

/// A backend that only records what's asked.
actor Recorder: CodeBackend {
    var calls: [String] = []

    func home() async throws -> PhoneHome { PhoneHome() }
    func options() async throws -> PhoneOptions { PhoneOptions() }
    func session(id: Int, after: Int, seen: Int, v: String, wait: Int) async throws -> PhoneView { PhoneView(id: id) }
    func send(id: Int, text: String) async throws -> PhoneOK { calls.append("send \(id) \(text)"); return PhoneOK(ok: true) }
    func send(id: Int, text: String, pictures: [CodeAttachment]) async throws -> PhoneOK { calls.append("pictures \(id) \(pictures.count)"); return PhoneOK(ok: true) }
    func steer(id: Int, text: String) async throws -> PhoneOK { calls.append("steer \(id) \(text)"); return PhoneOK(ok: true, steered: true) }
    func stop(id: Int) async throws -> PhoneOK { calls.append("stop \(id)"); return PhoneOK(ok: true) }
    func answer(card: String, choice: String, feedback: String?) async throws -> PhoneOK { calls.append("answer \(card) \(choice)"); return PhoneOK(ok: true) }
    func setMode(id: Int, mode: String) async throws -> PhoneOK { calls.append("mode \(mode)"); return PhoneOK(ok: true) }
    func setModel(id: Int, ref: String) async throws -> PhoneOK { calls.append("model \(ref)"); return PhoneOK(ok: true) }
    func newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Bool?) async throws -> PhoneOK { PhoneOK(ok: true, id: 1) }
    func land(id: Int) async throws -> PhoneOK { PhoneOK(ok: true) }
    func discard(id: Int) async throws -> PhoneOK { PhoneOK(ok: true) }
    func unpin() async throws -> PhoneOK { PhoneOK(ok: true) }
    func changes(id: Int, view: String) async throws -> PhoneChanges { PhoneChanges(id: id, files: []) }
    func hunk(id: Int, hunks: [String], action: String, view: String) async throws -> PhoneHunkResult {
        try LiveBackend.decode(PhoneHunkResult.self, Data(#"{"ok": true}"#.utf8))
    }
    func comment(id: Int, comments: [PhoneComment]) async throws -> PhoneOK { PhoneOK(ok: true) }
    func receipts(id: Int) async throws -> PhoneReceipts { PhoneReceipts(receipts: []) }
    func todos() async throws -> PhoneTodos { PhoneTodos(cards: []) }
    func startTodo(card: String) async throws -> PhoneOK { PhoneOK(ok: true) }
    func usage() async throws -> PhoneUsage { PhoneUsage() }
    func openPullRequest(id: Int) async throws -> PhoneOK { PhoneOK(ok: true) }
}
