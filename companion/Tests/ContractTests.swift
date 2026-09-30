import XCTest
@testable import JarvisCompanion

/// Every response in the companion contract (COMPANION_API.md), decoded as the Mac sends it,
/// and leniently when it doesn't.
final class ContractDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testStateAddsApprovalsSessionsDelegationsPushAndTLS() throws {
        let state = try decode(RemoteState.self, """
        {"state": "idle", "pending_approvals": 3,
         "approvals": [
            {"id": "a1", "question": "Send the email?", "detail": "To: Pepper", "source": "jarvis",
             "choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "Don't send"}]},
            {"id": "c7", "question": "Run npm test?", "source": "code", "task_id": 4,
             "choices": [{"id": "allow", "label": "Yes"}, {"id": "deny", "label": "No"}]},
            {"id": "old", "question": "From an older Mac", "task_id": "9"}
         ],
         "code_sessions": [
            {"id": 4, "title": "Fix the login bug", "project": "suit", "status": "working"},
            {"id": "5", "title": "", "project": "arc", "status": "needs_you"},
            {"id": 6, "title": "Docs", "project": "suit", "status": "resting"},
            {"id": 7, "title": "Odd", "status": "sleeping"},
            {"title": "no id"}
         ],
         "delegations_active": 2, "push": {"enabled": true, "registered": false}, "tls": true}
        """)
        XCTAssertEqual(state.pendingApprovals, 3)
        XCTAssertEqual(state.approvals.map(\.source), [.jarvis, .code, .code])  // a task_id means Jarvis Code
        XCTAssertEqual(state.approvals[1].taskID, 4)
        XCTAssertEqual(state.approvals[2].taskID, 9)
        XCTAssertEqual(state.codeSessions.map(\.id), [4, 5, 6, 7])
        XCTAssertEqual(state.codeSessions[1].title, "arc")  // no title: the project
        XCTAssertEqual(state.codeSessions.map(\.status), [.working, .needsYou, .resting, .unknown])
        XCTAssertEqual(state.liveCodeSessions.map(\.id), [4, 5])
        XCTAssertEqual(state.delegationsActive, 2)
        XCTAssertEqual(state.push, RemoteState.Push(enabled: true, registered: false))
        XCTAssertTrue(state.tls)
    }

    func testStateFromAnOlderMacStillWorks() throws {
        let state = try decode(RemoteState.self, #"{"state": "thinking", "approvals": [{"id": "x", "question": "OK?"}]}"#)
        XCTAssertEqual(state.pendingApprovals, 1)  // counted from the list
        XCTAssertTrue(state.codeSessions.isEmpty)
        XCTAssertEqual(state.delegationsActive, 0)
        XCTAssertNil(state.push)
        XCTAssertFalse(state.tls)
        // A number too big for Int never traps.
        let odd = try decode(RemoteState.self, #"{"pending_approvals": 1e300, "delegations_active": -4, "code_sessions": [{"id": 1e300}]}"#)
        XCTAssertEqual(odd.pendingApprovals, 0)
        XCTAssertEqual(odd.delegationsActive, 0)
        XCTAssertTrue(odd.codeSessions.isEmpty)
    }

    func testPairResult() throws {
        let result = try decode(PairResult.self, #"{"token": "t0k", "fingerprint": "\#(TestCertificate.fingerprint.uppercased())", "mac_name": "Tony's Mac"}"#)
        XCTAssertEqual(result.token, "t0k")
        XCTAssertEqual(result.fingerprint, TestCertificate.fingerprint)
        XCTAssertEqual(result.macName, "Tony's Mac")
        let older = try decode(PairResult.self, #"{"token": "t0k"}"#)
        XCTAssertNil(older.fingerprint)
        XCTAssertNil(older.macName)
        XCTAssertThrowsError(try decode(PairResult.self, #"{"token": ""}"#))
    }

    func testCodeSessions() throws {
        let list = try decode(CodeSessionList.self, """
        {"sessions": [
           {"id": 4, "title": "Fix the login bug", "project": "suit", "branch": "jarvis/login", "status": "needs_you",
            "mode": "ask", "model": "Opus 5.5", "cost_usd": 0.42, "updated_at": 1790000000,
            "waiting": {"approval_id": "c7", "question": "Run npm test?"}},
           {"id": 5, "title": "Docs", "project": "suit", "branch": "main", "status": "done", "mode": "edits",
            "model": "Sonnet", "cost_usd": "1.5", "updated_at": "2026-09-29T14:30:05"},
           {"id": "six", "title": "bad id"}
        ]}
        """)
        XCTAssertEqual(list.sessions.map(\.id), [4, 5])
        let first = list.sessions[0]
        XCTAssertEqual(first.branch, "jarvis/login")
        XCTAssertEqual(first.status, .needsYou)
        XCTAssertEqual(first.costUSD, 0.42)
        XCTAssertEqual(first.updatedAt, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertEqual(first.waiting, CodeWaiting(approvalID: "c7", question: "Run npm test?"))
        XCTAssertEqual(list.sessions[1].costUSD, 1.5)
        XCTAssertNotNil(list.sessions[1].updatedAt)
        XCTAssertNil(list.sessions[1].waiting)
        XCTAssertEqual(first.summary, CodeSessionSummary(id: 4, title: "Fix the login bug", project: "suit", status: .needsYou))
    }

    func testCodeSessionTranscriptTail() throws {
        let detail = try decode(CodeSessionDetail.self, """
        {"id": 4, "title": "Fix the login bug", "status": "working",
         "entries": [
            {"i": 12, "role": "assistant", "text": "Running the tests.", "at": 1790000010},
            {"i": 11, "role": "user", "text": "Fix it", "at": "2026-09-29T14:30:05"},
            {"i": 13, "role": "tool", "text": "Bash · npm test (summarized)"},
            {"i": 14, "role": "system?", "text": "odd role"},
            {"role": "note", "text": "no index"}
         ],
         "todos": [{"text": "Reproduce", "done": true}, {"text": "Fix", "done": 0}, {"text": "  "}],
         "waiting": {"approval_id": "c7", "question": "Run npm test?"}}
        """)
        XCTAssertEqual(detail.entries.map(\.i), [11, 12, 13, 14])  // in order, the one without an index skipped
        XCTAssertEqual(detail.entries.map(\.role), [.user, .assistant, .tool, .note])
        XCTAssertEqual(detail.todos, [CodeTodo(text: "Reproduce", done: true), CodeTodo(text: "Fix", done: false)])
        XCTAssertEqual(detail.waiting?.approvalID, "c7")
        XCTAssertEqual(detail.status, .working)
    }

    func testTranscriptMergesIncrementallyAndStaysBounded() {
        var transcript = CodeTranscript()
        XCTAssertNil(transcript.after)
        XCTAssertEqual(transcript.merge([CodeEntry(i: 3, role: .user, text: "a"), CodeEntry(i: 4, role: .assistant, text: "b")]), 2)
        XCTAssertEqual(transcript.after, 4)
        // An overlapping answer adds only what's new, once.
        XCTAssertEqual(transcript.merge([CodeEntry(i: 4, role: .assistant, text: "b"), CodeEntry(i: 5, role: .tool, text: "c"), CodeEntry(i: 5, role: .tool, text: "c")]), 1)
        XCTAssertEqual(transcript.entries.map(\.i), [3, 4, 5])
        transcript.merge((6..<(6 + CodeTranscript.limit)).map { CodeEntry(i: $0, role: .note, text: "") })
        XCTAssertEqual(transcript.entries.count, CodeTranscript.limit)
        XCTAssertEqual(transcript.after, 5 + CodeTranscript.limit)
    }

    func testDiff() throws {
        let diff = try decode(CodeDiff.self, """
        {"files": [
           {"path": "src/login.py", "status": "M", "added": 3, "removed": 1,
            "hunks": [{"header": "@@ -10,4 +10,6 @@ def login", "lines": [" ctx", "+added", "-removed", "+again"]}]},
           {"path": ".env", "status": "M", "added": 1, "removed": 1, "hunks": []},
           {"path": "new.txt", "status": "a", "added": 1, "removed": 0, "hunks": [{"header": "@@ -0,0 +1 @@", "lines": ["+hi"]}]},
           {"status": "D"}
        ]}
        """)
        XCTAssertEqual(diff.files.map(\.path), ["src/login.py", ".env", "new.txt"])
        XCTAssertEqual(diff.files.map(\.status), [.modified, .modified, .added])
        XCTAssertFalse(diff.files[0].isHidden)
        XCTAssertTrue(diff.files[1].isHidden)  // a credential file comes without lines
        XCTAssertEqual(diff.added, 5)
        XCTAssertEqual(diff.removed, 2)
        XCTAssertEqual(diff.files[0].hunks[0].lines.map(DiffLineKind.init), [.context, .added, .removed, .added])
    }

    func testDigest() throws {
        let digest = try decode(Digest.self, """
        {"items": [
           {"who": "Pepper", "kind": "text", "summary": "Dinner moved to 8", "at": 1790000000, "urgent": false},
           {"who": "Happy", "kind": "email", "summary": "The car is ready.", "at": 1790003600, "urgent": true},
           {"who": "", "kind": "call", "summary": "", "at": "2026-09-29T09:00:00"},
           {"who": "Rhodey", "kind": "voicemail", "summary": "Call back", "at": 1789990000, "urgent": false}
        ]}
        """)
        XCTAssertEqual(digest.items.count, 4)
        XCTAssertEqual(digest.items[2].who, "Someone")
        XCTAssertEqual(digest.sorted.first?.who, "Happy")  // urgent first
        XCTAssertEqual(digest.sorted.map(\.kind), [.email, .call, .text, .voicemail])  // then newest first
        XCTAssertEqual(
            digest.spoken,
            "4 things in the last day. Urgent, from Happy: The car is ready. Missed call from Someone. "
                + "Message from Pepper: Dinner moved to 8. And 1 more in the app."
        )
        XCTAssertEqual(Digest(items: []).spoken, "Nothing new in the last day.")
    }

    func testDelegations() throws {
        let list = try decode(DelegationList.self, """
        {"items": [
           {"id": "d1", "with": "Dr. Chen's office", "goal": "Book a cleaning next week", "status": "active",
            "messages": 4, "updated_at": 1790000000},
           {"id": "d2", "with": "Happy", "goal": "Pick a time", "status": "waiting_owner", "messages": "2"},
           {"id": "d3", "with": "Garage", "goal": "Quote", "status": "done", "messages": 7},
           {"with": "no id"}
        ]}
        """)
        XCTAssertEqual(list.items.map(\.id), ["d1", "d2", "d3"])
        XCTAssertEqual(list.items.map(\.isOpen), [true, true, false])
        XCTAssertEqual(list.items[1].messages, 2)
        XCTAssertEqual(list.items[1].statusLabel, "Needs you")
        XCTAssertEqual(list.items[0].updatedAt, Date(timeIntervalSince1970: 1_790_000_000))
    }

    func testSpending() throws {
        let spending = try decode(Spending.self, """
        {"recent": [
            {"at": 1790000000, "merchant": "Blue Bottle", "amount": 6.5, "currency": "usd", "kind": "purchase"},
            {"at": 1790009000, "merchant": "Pepper", "amount": "40", "currency": "USD", "kind": "transfer"}
         ],
         "limits": {"purchase": 200, "transfer": 100, "day": 300, "currency": "USD"},
         "today_total": 46.5}
        """)
        XCTAssertEqual(spending.recent.map(\.merchant), ["Pepper", "Blue Bottle"])  // newest first
        XCTAssertEqual(spending.recent[1].currency, "USD")
        XCTAssertEqual(spending.recent[0].amount, 40)
        XCTAssertEqual(spending.limits.purchase, 200)
        XCTAssertEqual(spending.todayTotal, 46.5)
        XCTAssertEqual(try XCTUnwrap(spending.dayUsed), 0.155, accuracy: 0.0001)
        let none = try decode(Spending.self, #"{"recent": [], "limits": {}, "today_total": 0}"#)
        XCTAssertNil(none.dayUsed)
    }

    func testRoutines() throws {
        let list = try decode(RoutineList.self, """
        {"items": [
           {"id": "r1", "name": "Morning", "schedule_text": "weekdays at 07:00", "enabled": true, "next_run": "2026-09-30T07:00"},
           {"id": "r2", "name": "Portfolio", "schedule_text": "Mondays and Fridays at 16:00", "enabled": false, "next_run": null},
           {"id": "r3", "name": "Wind down", "schedule_text": "daily at 22:30", "time": "22:30", "days": [6, 0, 9]},
           {"name": "no id"}
        ]}
        """)
        XCTAssertEqual(list.items.map(\.id), ["r1", "r2", "r3"])
        XCTAssertEqual(list.items[0].clock, "07:00")  // from the next run
        XCTAssertEqual(list.items[0].weekdays, [0, 1, 2, 3, 4])
        XCTAssertEqual(list.items[1].weekdays, [0, 4])
        XCTAssertFalse(list.items[1].enabled)
        XCTAssertNil(list.items[1].clock)
        XCTAssertEqual(list.items[2].clock, "22:30")
        XCTAssertEqual(list.items[2].weekdays, [0, 6])  // from the Mac, out-of-range dropped
    }

    func testRoutineSchedule() {
        XCTAssertEqual(RoutineSchedule.clock("7:05"), "07:05")
        XCTAssertEqual(RoutineSchedule.clock("07:05:00"), "07:05")
        XCTAssertNil(RoutineSchedule.clock("25:00"))
        XCTAssertNil(RoutineSchedule.clock("soon"))
        XCTAssertEqual(RoutineSchedule.days(in: "daily at 07:00"), Array(0...6))
        XCTAssertEqual(RoutineSchedule.days(in: "Saturdays at 9"), [5])
        XCTAssertNil(RoutineSchedule.days(in: "once on 2026-10-01 at 01:00"))
    }

    func testAskAndOkBodies() throws {
        let result = try decode(AskResult.self, #"{"reply": "Done.", "done": true, "approvals": []}"#)
        XCTAssertEqual(result.reply, "Done.")
        XCTAssertTrue(result.done)
    }

    func testStatusCodesMeanWhatTheContractSays() {
        func error(_ status: Int, _ body: String = "{}", pairing: Bool = false) -> JarvisError? {
            do {
                _ = try JarvisAPI.check(status: status, data: Data(body.utf8), pairing: pairing)
                return nil
            } catch {
                return error as? JarvisError
            }
        }
        XCTAssertNil(error(200))
        XCTAssertEqual(error(401), .unpaired)
        XCTAssertEqual(error(409, #"{"error": "fingerprint"}"#, pairing: true), .fingerprintRefused)
        XCTAssertEqual(error(409, #"{"error": "already"}"#), .rejected("already"))
        XCTAssertEqual(error(403, #"{"error": "Too many wrong codes. Wait five minutes."}"#, pairing: true), .wrongCode("Too many wrong codes. Wait five minutes."))
        XCTAssertEqual(error(403, #"{"error": "no"}"#), .rejected("no"))
        XCTAssertEqual(error(404, pairing: true), .notJarvis)
        XCTAssertEqual(error(404), .unsupported)
        XCTAssertEqual(error(413), .tooBig)
        XCTAssertEqual(error(429, #"{"error": "Still on your last request."}"#), .busy("Still on your last request."))
        XCTAssertEqual(error(503), .unavailable)
        XCTAssertEqual(error(500, #"{"error": "boom"}"#), .server(500, "boom"))
    }
}

/// What this device sends, in the contract's shapes.
final class RequestBodyTests: XCTestCase {
    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testLocation() throws {
        let report = LocationReport(latitude: 34.0259, longitude: -118.7798, accuracy: 12.4, at: Date(timeIntervalSince1970: 1_790_000_000), event: .arrive, region: .home)
        let body = try object(report.body.encoded())
        XCTAssertEqual(body["lat"] as? Double, 34.0259)
        XCTAssertEqual(body["lon"] as? Double, -118.7798)
        XCTAssertEqual(body["accuracy"] as? Double, 12)
        XCTAssertEqual(body["at"] as? Int, 1_790_000_000)
        XCTAssertEqual(body["event"] as? String, "arrive")
        XCTAssertEqual(body["region"] as? String, "home")
        let plain = try object(LocationReport(latitude: 1, longitude: 2, accuracy: 3, at: Date()).body.encoded())
        XCTAssertNil(plain["event"])
        XCTAssertNil(plain["region"])
    }

    func testHealth() throws {
        let day = HealthDay(day: "2026-09-28", steps: 8421, sleepHours: 7.46, restingHeartRate: 54, workouts: [.init(kind: "running", minutes: 32)])
        let body = try object(day.body.encoded())
        XCTAssertEqual(body["day"] as? String, "2026-09-28")
        XCTAssertEqual(body["steps"] as? Int, 8421)
        XCTAssertEqual(body["sleep_hours"] as? Double, 7.5)
        XCTAssertEqual(body["resting_hr"] as? Int, 54)
        let workouts = try XCTUnwrap(body["workouts"] as? [[String: Any]])
        XCTAssertEqual(workouts.first?["kind"] as? String, "running")
        XCTAssertEqual(workouts.first?["minutes"] as? Int, 32)
        let partial = try object(HealthDay(day: "2026-09-29", steps: 120).body.encoded())
        XCTAssertEqual(Set(partial.keys), ["day", "steps"])
        XCTAssertTrue(HealthDay(day: "2026-09-29").isEmpty)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        XCTAssertEqual(HealthDay.key(for: Date(timeIntervalSince1970: 1_790_000_000), calendar: calendar), "2026-09-21")
    }

    func testShareSplicesTheDataInWithoutAnEncoder() throws {
        let bytes = Data((0..<600).map { UInt8($0 % 256) })
        let item = ShareItem(kind: .file, name: "notes \"v2\".pdf", data: bytes, note: "  summarize this  ")
        let body = try object(item.body())
        XCTAssertEqual(body["kind"] as? String, "file")
        XCTAssertEqual(body["name"] as? String, "notes \"v2\".pdf")
        XCTAssertEqual(body["note"] as? String, "summarize this")
        XCTAssertEqual((body["data_base64"] as? String).flatMap { Data(base64Encoded: $0) }, bytes)
        let url = try object(ShareItem(kind: .url, url: "https://example.com/a?b=c", note: "").body())
        XCTAssertEqual(url["url"] as? String, "https://example.com/a?b=c")
        XCTAssertNil(url["note"])
        XCTAssertNil(url["data_base64"])
    }

    func testCommands() throws {
        XCTAssertEqual(MacCommand.meetingStart(title: "Meeting").json, ["type": "meeting_start", "title": "Meeting"])
        XCTAssertEqual(MacCommand.runRoutine(id: "r1").json, ["type": "routine_run", "id": "r1"])
        XCTAssertTrue(MacCommand.briefing.keepsWhenOffline)
        XCTAssertFalse(MacCommand.stop.keepsWhenOffline)
        XCTAssertFalse(MacCommand.meetingStart(title: "x").keepsWhenOffline)
    }

    func testJSONValueRoundTripsAndDropsNulls() throws {
        let value: JSONValue = ["a": 1, "b": [true, "x", 2.5], "c": .null]
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: value.encoded()), value)
        XCTAssertEqual(JSONValue.object(dropping: ["a": .int(1), "b": nil]), ["a": 1])
        XCTAssertEqual(String(data: try JSONValue.int(3).encoded(), encoding: .utf8), "3")
    }
}

final class PushPayloadTests: XCTestCase {
    func testReadsTheJarvisKey() throws {
        let info: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Jarvis needs your OK", "body": "Email Pepper?"], "category": "JARVIS_APPROVAL"],
            "jarvis": [
                "kind": "approval", "id": "a1b2", "task_id": NSNull(), "at": 1_790_000_000,
                "choices": [["id": "allow", "label": "Send"], ["id": "deny", "label": "Don't send"], ["label": "no id"]],
            ],
        ]
        let push = try XCTUnwrap(JarvisPush(userInfo: info))
        XCTAssertEqual(push.kind, .approval)
        XCTAssertTrue(push.isApproval)
        XCTAssertEqual(push.id, "a1b2")
        XCTAssertNil(push.taskID)
        XCTAssertEqual(push.choices.map(\.id), ["allow", "deny"])
        XCTAssertEqual(push.at, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertEqual(push.title, "Jarvis needs your OK")
        XCTAssertEqual(push.body, "Email Pepper?")

        let code = try XCTUnwrap(JarvisPush(userInfo: ["jarvis": ["kind": "code_needs_you", "id": 17, "task_id": "4"], "aps": ["alert": "Jarvis Code needs you"]]))
        XCTAssertEqual(code.kind, .codeNeedsYou)
        XCTAssertEqual(code.id, "17")
        XCTAssertEqual(code.taskID, 4)
        XCTAssertEqual(code.body, "Jarvis Code needs you")
        XCTAssertFalse(code.isApproval)

        XCTAssertEqual(JarvisPush(userInfo: ["jarvis": ["kind": "something-new"]])?.kind, .unknown)
        XCTAssertNil(JarvisPush(userInfo: ["aps": ["alert": "not ours"]]))
    }
}
