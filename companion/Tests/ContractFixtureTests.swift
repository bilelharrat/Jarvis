import XCTest
@testable import JarvisCompanion

/// The Mac's own answers, written from its real routes by tests/test_companion_contract.py
/// (see Fixtures/), decoded with the apps' models: every field the apps read must come
/// through as the Mac sent it, with nothing skipped or left at a fallback.
final class ContractFixtureTests: XCTestCase {
    struct Fixture {
        var status: Int
        var data: Data
        var json: Any
        var object: [String: Any] { json as? [String: Any] ?? [:] }
    }

    static func fixture(_ name: String) throws -> Fixture {
        let url = try XCTUnwrap(Bundle(for: ContractFixtureTests.self).url(forResource: name, withExtension: "json"), "no fixture \(name)")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let status = try XCTUnwrap(file["status"] as? Int)
        if let body = file["body"] {
            return Fixture(status: status, data: try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]), json: body)
        }
        let text = file["text"] as? String ?? ""
        return Fixture(status: status, data: Data(text.utf8), json: text)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> (T, [String: Any]) {
        let fixture = try Self.fixture(name)
        XCTAssertEqual(fixture.status, 200, name)
        return (try JSONDecoder().decode(T.self, from: fixture.data), fixture.object)
    }

    private func list(_ object: [String: Any], _ key: String) -> [[String: Any]] {
        object[key] as? [[String: Any]] ?? []
    }

    /// A timestamp as the Mac wrote it, read the way the apps read one.
    private func date(_ value: Any?) -> Date? {
        (value as? String).flatMap(LooseDate.parse) ?? (value as? Double).flatMap(LooseDate.epoch)
    }

    // MARK: - Pairing

    func testPairing() throws {
        let (pair, json) = try decode(PairResult.self, "pair")
        XCTAssertEqual(pair.token, json["token"] as? String)
        XCTAssertEqual(pair.fingerprint, json["fingerprint"] as? String)
        XCTAssertEqual(pair.macName, "Studio")
    }

    // MARK: - The state

    func testState() throws {
        let (state, json) = try decode(RemoteState.self, "state")
        XCTAssertEqual(state.state.rawValue, json["state"] as? String)
        let turn = json["turn"] as? [String: Any] ?? [:]
        XCTAssertEqual(state.turn.user, turn["user"] as? String)
        XCTAssertEqual(state.turn.reply, turn["reply"] as? String)

        let approvals = list(json, "approvals")
        XCTAssertEqual(state.approvals.count, approvals.count)
        for (approval, raw) in zip(state.approvals, approvals) {
            XCTAssertEqual(approval.id, raw["id"] as? String)
            XCTAssertEqual(approval.question, raw["question"] as? String)
            XCTAssertEqual(approval.detail, raw["detail"] as? String)
            XCTAssertEqual(approval.source.rawValue, raw["source"] as? String)
            XCTAssertEqual(approval.taskID, raw["task_id"] as? Int)
            let choices = (raw["choices"] as? [[String: String]] ?? []).map { ApprovalChoice(id: $0["id"] ?? "", label: $0["label"] ?? "") }
            XCTAssertEqual(approval.choices, choices)
        }
        XCTAssertEqual(state.pendingApprovals, json["pending_approvals"] as? Int)

        let history = list(json, "history")
        XCTAssertEqual(state.history.count, history.count)
        for (item, raw) in zip(state.history, history) {
            XCTAssertEqual(item.role.rawValue, raw["role"] as? String)
            XCTAssertEqual(item.text, raw["text"] as? String)
            XCTAssertEqual(item.at, raw["at"] as? String)
            XCTAssertNotNil(item.date, "history time \(item.at)")
        }

        let weather = try XCTUnwrap(state.weather)
        let rawWeather = json["weather"] as? [String: Any] ?? [:]
        XCTAssertEqual(weather.city, rawWeather["city"] as? String)
        XCTAssertEqual(weather.summary, rawWeather["summary"] as? String)
        XCTAssertEqual(weather.unit, rawWeather["unit"] as? String)
        XCTAssertEqual(weather.temp, (rawWeather["temp"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(weather.high, (rawWeather["high"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(weather.low, (rawWeather["low"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(weather.code, rawWeather["code"] as? Int)
        XCTAssertTrue(weather.isAvailable)

        let next = try XCTUnwrap(state.nextEvent)
        let rawNext = json["next_event"] as? [String: Any] ?? [:]
        XCTAssertEqual(next.title, rawNext["title"] as? String)
        XCTAssertEqual(next.begin, rawNext["begin"] as? String)
        XCTAssertEqual(next.location, rawNext["location"] as? String)
        XCTAssertNotNil(next.date, "next event time \(next.begin)")

        let tasks = list(json, "tasks")
        XCTAssertEqual(state.tasks.map(\.id), tasks.map { "\($0["id"] ?? "")" })
        XCTAssertEqual(state.tasks.map(\.label), tasks.map { $0["label"] as? String ?? "" })
        XCTAssertEqual(state.tasks.map(\.status), tasks.map { $0["status"] as? String ?? "" })
        XCTAssertEqual(state.tasks.map(\.lastAction), tasks.map { $0["last_action"] as? String ?? "" })

        XCTAssertEqual(state.routines.map(\.id), list(json, "routines").map { $0["id"] as? String ?? "" })
        XCTAssertEqual(state.routines.map(\.name), list(json, "routines").map { $0["name"] as? String ?? "" })
        XCTAssertEqual(state.model, json["model"] as? String)
        XCTAssertNil(state.meeting)

        let sessions = list(json, "code_sessions")
        XCTAssertEqual(state.codeSessions.count, sessions.count)
        for (session, raw) in zip(state.codeSessions, sessions) {
            XCTAssertEqual(session.id, raw["id"] as? Int)
            XCTAssertEqual(session.title, raw["title"] as? String)
            XCTAssertEqual(session.project, raw["project"] as? String)
            XCTAssertEqual(session.status.rawValue, raw["status"] as? String)
        }
        XCTAssertEqual(state.delegationsActive, json["delegations_active"] as? Int)
        XCTAssertEqual(state.push, RemoteState.Push(enabled: false, registered: true))
        XCTAssertTrue(state.tls)
    }

    // MARK: - Asking

    func testAskAnswers() throws {
        let (done, doneJSON) = try decode(AskResult.self, "ask_done")
        XCTAssertTrue(done.done)
        XCTAssertEqual(done.reply, doneJSON["reply"] as? String)
        XCTAssertFalse(done.reply.isEmpty)

        // /api/ask's cards come as the hub keeps them (no "source"): JARVIS's own.
        let (waiting, waitingJSON) = try decode(AskResult.self, "ask_needs_ok")
        XCTAssertFalse(waiting.done)
        let card = try XCTUnwrap(waiting.approvals.first)
        let raw = try XCTUnwrap(list(waitingJSON, "approvals").first)
        XCTAssertEqual(card.id, raw["id"] as? String)
        XCTAssertEqual(card.question, raw["question"] as? String)
        XCTAssertEqual(card.choices.map(\.id), ["allow", "deny"])
        XCTAssertEqual(card.source, .jarvis)

        let (photo, photoJSON) = try decode(AskResult.self, "photo")
        XCTAssertTrue(photo.done)
        XCTAssertEqual(photo.reply, photoJSON["reply"] as? String)
    }

    // MARK: - Eden Code

    func testCodeSessions() throws {
        let (list, json) = try decode(CodeSessionList.self, "code_sessions")
        let raw = self.list(json, "sessions")
        XCTAssertEqual(list.sessions.count, raw.count)
        for (session, item) in zip(list.sessions, raw) {
            XCTAssertEqual(session.id, item["id"] as? Int)
            XCTAssertEqual(session.title, item["title"] as? String)
            XCTAssertEqual(session.project, item["project"] as? String)
            XCTAssertEqual(session.branch, item["branch"] as? String)
            XCTAssertEqual(session.status.rawValue, item["status"] as? String)
            XCTAssertEqual(session.mode, item["mode"] as? String)
            XCTAssertEqual(session.model, item["model"] as? String)
            XCTAssertEqual(session.costUSD, item["cost_usd"] as? Double)
            XCTAssertNotNil(session.updatedAt)
            XCTAssertEqual(session.updatedAt, date(item["updated_at"]))
            let waiting = item["waiting"] as? [String: Any]
            XCTAssertEqual(session.waiting?.approvalID, waiting?["approval_id"] as? String)
            XCTAssertEqual(session.waiting?.question, waiting?["question"] as? String)
        }
        XCTAssertNotNil(list.sessions.first { $0.waiting != nil })
    }

    func testCodeSessionTranscript() throws {
        for name in ["code_session", "code_session_after"] {
            let (detail, json) = try decode(CodeSessionDetail.self, name)
            XCTAssertEqual(detail.id, json["id"] as? Int)
            XCTAssertEqual(detail.title, json["title"] as? String)
            XCTAssertEqual(detail.status.rawValue, json["status"] as? String)
            let entries = list(json, "entries")
            XCTAssertEqual(detail.entries.count, entries.count, "an entry was skipped")
            for (entry, raw) in zip(detail.entries, entries) {
                XCTAssertEqual(entry.i, raw["i"] as? Int)
                XCTAssertEqual(entry.role.rawValue, raw["role"] as? String)
                XCTAssertEqual(entry.text, raw["text"] as? String)
                XCTAssertNotNil(entry.at)
                XCTAssertEqual(entry.at, date(raw["at"]))
            }
            let todos = list(json, "todos")
            XCTAssertEqual(detail.todos, todos.map { CodeTodo(text: $0["text"] as? String ?? "", done: $0["done"] as? Bool ?? false) })
            let waiting = json["waiting"] as? [String: Any]
            XCTAssertEqual(detail.waiting?.approvalID, waiting?["approval_id"] as? String)
        }
        // Paging: what comes after a known entry continues the transcript.
        var transcript = CodeTranscript()
        let (first, _) = try decode(CodeSessionDetail.self, "code_session")
        let (after, _) = try decode(CodeSessionDetail.self, "code_session_after")
        transcript.merge(Array(first.entries.prefix(3)))
        XCTAssertEqual(transcript.after, 4)
        transcript.merge(after.entries)
        XCTAssertEqual(transcript.entries.map(\.i), first.entries.map(\.i))
    }

    func testCodeDiff() throws {
        let (diff, json) = try decode(CodeDiff.self, "code_diff")
        let files = list(json, "files")
        XCTAssertEqual(diff.files.count, files.count)
        for (file, raw) in zip(diff.files, files) {
            XCTAssertEqual(file.path, raw["path"] as? String)
            XCTAssertEqual(file.status.rawValue, raw["status"] as? String)
            XCTAssertEqual(file.added, raw["added"] as? Int)
            XCTAssertEqual(file.removed, raw["removed"] as? Int)
            let hunks = raw["hunks"] as? [[String: Any]] ?? []
            XCTAssertEqual(file.hunks, hunks.map { DiffHunk(header: $0["header"] as? String ?? "", lines: $0["lines"] as? [String] ?? []) })
        }
        XCTAssertTrue(try XCTUnwrap(diff.files.first { $0.path == ".env" }).isHidden)  // listed, never shown
        XCTAssertFalse(try XCTUnwrap(diff.files.first { $0.path == "login.js" }).isHidden)
    }

    // MARK: - Everything else

    func testDigest() throws {
        let (digest, json) = try decode(Digest.self, "digest")
        let items = list(json, "items")
        XCTAssertEqual(digest.items.count, items.count)
        for (item, raw) in zip(digest.items, items) {
            XCTAssertEqual(item.who, raw["who"] as? String)
            XCTAssertEqual(item.kind.rawValue, raw["kind"] as? String)
            XCTAssertEqual(item.summary, raw["summary"] as? String)
            XCTAssertEqual(item.urgent, raw["urgent"] as? Bool)
            XCTAssertNotNil(item.at)
            XCTAssertEqual(item.at, date(raw["at"]))
        }
        XCTAssertFalse(digest.items.contains { $0.kind == .other })
    }

    func testDelegations() throws {
        let (list, json) = try decode(DelegationList.self, "delegations")
        let items = self.list(json, "items")
        XCTAssertEqual(list.items.count, items.count)
        for (item, raw) in zip(list.items, items) {
            XCTAssertEqual(item.id, raw["id"] as? String)
            XCTAssertEqual(item.with, raw["with"] as? String)
            XCTAssertEqual(item.goal, raw["goal"] as? String)
            XCTAssertEqual(item.status, raw["status"] as? String)
            XCTAssertEqual(item.messages, raw["messages"] as? Int)
            XCTAssertNotNil(item.updatedAt)
            XCTAssertEqual(item.updatedAt, date(raw["updated_at"]))
        }
        XCTAssertEqual(list.items.filter(\.isOpen).map(\.id), ["d1"])
    }

    func testSpending() throws {
        let (spending, json) = try decode(Spending.self, "spending")
        let recent = list(json, "recent")
        XCTAssertEqual(spending.recent.count, recent.count)
        for raw in recent {
            let item = try XCTUnwrap(spending.recent.first { $0.merchant == raw["merchant"] as? String })
            XCTAssertEqual(item.amount, (raw["amount"] as? NSNumber)?.doubleValue)
            XCTAssertEqual(item.currency, raw["currency"] as? String)
            XCTAssertEqual(item.kind, raw["kind"] as? String)
            XCTAssertNotNil(item.at)
            XCTAssertEqual(item.at, date(raw["at"]))
        }
        let limits = json["limits"] as? [String: Any] ?? [:]
        XCTAssertEqual(spending.limits.purchase, (limits["purchase"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(spending.limits.transfer, (limits["transfer"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(spending.limits.day, (limits["day"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(spending.limits.currency, limits["currency"] as? String)
        XCTAssertEqual(spending.todayTotal, (json["today_total"] as? NSNumber)?.doubleValue)
    }

    func testRoutines() throws {
        let (list, json) = try decode(RoutineList.self, "routines")
        let items = self.list(json, "items")
        XCTAssertEqual(list.items.count, items.count)
        for (item, raw) in zip(list.items, items) {
            XCTAssertEqual(item.id, raw["id"] as? String)
            XCTAssertEqual(item.name, raw["name"] as? String)
            XCTAssertEqual(item.scheduleText, raw["schedule_text"] as? String)
            XCTAssertEqual(item.enabled, raw["enabled"] as? Bool)
            XCTAssertEqual(item.nextRun, date(raw["next_run"]))
            if raw["next_run"] is String { XCTAssertNotNil(item.nextRun) }
            // This Mac doesn't send them: the apps read them from the schedule text.
            XCTAssertNil(raw["time"])
            XCTAssertNil(raw["days"])
        }
    }

    func testShareAnswers() throws {
        let (saved, savedJSON) = try decode(ShareResult.self, "share")
        XCTAssertEqual(saved.savedAs, savedJSON["saved_as"] as? String)
        XCTAssertFalse(saved.asked)
        let (asked, _) = try decode(ShareResult.self, "share_asked")
        XCTAssertTrue(asked.asked)
        XCTAssertNotNil(asked.savedAs)
    }

    // MARK: - Errors

    func testErrorsReadAsTheMacMeantThem() throws {
        func error(_ name: String, pairing: Bool = false) throws -> JarvisError? {
            let fixture = try Self.fixture(name)
            XCTAssertNotEqual(fixture.status, 200, name)
            do {
                _ = try JarvisAPI.check(status: fixture.status, data: fixture.data, pairing: pairing)
                return nil
            } catch let error as JarvisError {
                return error
            }
        }
        XCTAssertEqual(try error("error_unpaired"), .unpaired)
        XCTAssertEqual(try error("error_pair_fingerprint", pairing: true), .fingerprintRefused)
        let code = try Self.fixture("error_pair_code").object["error"] as? String
        XCTAssertEqual(try error("error_pair_code", pairing: true), .wrongCode(code ?? ""))
        XCTAssertEqual(try error("error_busy"), .busy("Jarvis is busy. Try again in a moment."))
        XCTAssertEqual(try error("error_too_big"), .tooBig)
        XCTAssertEqual(try error("error_share_refused"), .rejected("not a picture"))
        // An endpoint this Mac doesn't have yet.
        XCTAssertEqual(try error("error_unknown_endpoint"), .unsupported)
    }

    /// The Mac answers 404 for a session, routine or conversation it no longer has, with its
    /// reason: that isn't a Mac that needs updating (which answers 404 with no reason).
    func testSomethingGoneOnTheMacIsntAnOlderMac() throws {
        for name in ["error_no_session", "error_no_routine"] {
            let fixture = try Self.fixture(name)
            XCTAssertThrowsError(try JarvisAPI.check(status: fixture.status, data: fixture.data)) { error in
                let problem = error as? JarvisError
                XCTAssertNotEqual(problem, .unsupported, name)
                XCTAssertEqual(problem?.title, "Not on your Mac anymore", name)
                XCTAssertFalse(problem?.neverDelivered ?? true, name)
            }
        }
    }

    /// An Eden Code session whose turn is over is "waiting" in the Mac's task list: it
    /// isn't running.
    func testOnlyTasksThatAreRunningCountAsRunning() throws {
        let (state, json) = try decode(RemoteState.self, "state")
        let running = list(json, "tasks").filter { $0["status"] as? String == "running" }.map { "\($0["id"] ?? "")" }
        XCTAssertFalse(running.isEmpty)
        XCTAssertTrue(state.tasks.contains { $0.status == "waiting" })
        XCTAssertEqual(state.activeTasks.map(\.id), running)
    }

    // MARK: - The phone's contacts and calendar

    func testTheMacsAsksOfThePhone() throws {
        let (state, json) = try decode(RemoteState.self, "state_asks")
        let asks = list(json, "phone_asks")
        XCTAssertFalse(asks.isEmpty)
        XCTAssertEqual(state.phoneAsks.map(\.id), asks.compactMap { $0["id"] as? String })
        XCTAssertEqual(state.phoneAsks.first?.kind, .contact)
        XCTAssertEqual(state.phoneAsks.first?.name, asks.first?["name"] as? String)
        let (plain, _) = try decode(RemoteState.self, "state")
        XCTAssertEqual(plain.phoneAsks, [])
    }

    func testTheMacTookTheSensorsCalendarAndAnswer() throws {
        for name in ["sensors", "calendar", "contacts_answer"] {
            let fixture = try Self.fixture(name)
            XCTAssertEqual(fixture.status, 200, name)
            XCTAssertEqual(fixture.object["ok"] as? Bool, true, name)
        }
        XCTAssertEqual(try Self.fixture("calendar").object["events"] as? Int, 1)
    }
}
