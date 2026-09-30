import XCTest
@testable import JarvisCompanion

/// Live Activities: the content state the Mac pushes, and which activities to start,
/// update and end.
final class LiveActivityTests: XCTestCase {
    typealias Content = JarvisActivityAttributes.ContentState

    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    func testContentStateIsTheContractsExactly() throws {
        let full = try JSONDecoder().decode(Content.self, from: Data("""
        {"title": "Fix the login bug", "status": "Working", "detail": "Running the tests", "progress": 0.4,
         "needsYou": false, "updatedAt": 1790000000}
        """.utf8))
        XCTAssertEqual(full, Content(title: "Fix the login bug", status: "Working", detail: "Running the tests", progress: 0.4, needsYou: false, updatedAt: 1_790_000_000))
        XCTAssertEqual(full.updated, now)

        // The Mac leaves progress out when it doesn't know it.
        let noProgress = try JSONDecoder().decode(Content.self, from: Data(#"{"title": "Call", "status": "On the call", "detail": "", "needsYou": true, "updatedAt": 1790000000}"#.utf8))
        XCTAssertNil(noProgress.progress)
        XCTAssertTrue(noProgress.needsYou)

        // Missing or odd fields fall back rather than failing the update.
        let odd = try JSONDecoder().decode(Content.self, from: Data(#"{"status": 3, "progress": "1.7", "updatedAt": "1790000000"}"#.utf8))
        XCTAssertEqual(odd.title, "Jarvis")
        XCTAssertEqual(odd.status, "3")
        XCTAssertEqual(odd.progress, 1)  // clamped to 0...1
        XCTAssertFalse(odd.needsYou)
        XCTAssertEqual(odd.updatedAt, 1_790_000_000)

        // What the app encodes reads back the same, without progress when there's none.
        let encoded = try JSONEncoder().encode(noProgress)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["title", "status", "detail", "needsYou", "updatedAt"])
        XCTAssertEqual(try JSONDecoder().decode(Content.self, from: encoded), noProgress)
    }

    func testKeysAndDestinationsFollowTheMac() {
        XCTAssertEqual(JarvisActivityAttributes(kind: .code, itemID: "4").key, "code:4")
        XCTAssertEqual(JarvisActivityAttributes(kind: .call, itemID: "a1b2c3d4").key, "call:a1b2c3d4")
        XCTAssertEqual(JarvisActivityAttributes(kind: .code, itemID: "4").destination, .codeSession(4))
        XCTAssertEqual(JarvisActivityAttributes(kind: .delegation, itemID: "d1").destination, .conversations)
        XCTAssertEqual(JarvisActivityAttributes(kind: .video, itemID: "2").destination, .home)
    }

    func testWhatShouldShow() {
        let sessions = [
            CodeSessionSummary(id: 1, title: "Docs", project: "arc", status: .working),
            CodeSessionSummary(id: 2, title: "Login", project: "suit", status: .needsYou),
            CodeSessionSummary(id: 3, title: "Old", project: "suit", status: .done),
        ]
        let delegations = [
            DelegationItem(id: "d1", with: "Dr. Chen", goal: "Book a cleaning", status: "active"),
            DelegationItem(id: "d2", with: "Garage", goal: "Quote", status: "done"),
        ]
        let wanted = LiveActivityPlan.wanted(sessions: sessions, delegations: delegations, now: now)
        XCTAssertEqual(wanted.map(\.key), ["code:2", "code:1", "delegation:d1"])  // needs you first
        XCTAssertTrue(wanted[0].content.needsYou)
        XCTAssertEqual(wanted[0].content.detail, "suit")
        XCTAssertEqual(wanted[1].content.detail, "arc")
        XCTAssertEqual(wanted[2].content.title, "Dr. Chen")
        XCTAssertEqual(wanted[2].content.status, "Talking")
        XCTAssertEqual(LiveActivityPlan.wanted(sessions: sessions, delegations: nil, now: now).count, 2)
    }

    func testStartsUpdatesAndEnds() {
        let sessions = [
            CodeSessionSummary(id: 1, title: "Docs", project: "arc", status: .needsYou),
            CodeSessionSummary(id: 2, title: "Login", project: "suit", status: .done),
        ]
        let wanted = LiveActivityPlan.wanted(sessions: sessions, delegations: [], now: now)
        let existing: [String: Content] = [
            "code:1": Content(title: "Docs", status: "Working", detail: "arc", updatedAt: 0),
            "code:2": Content(title: "Login", status: "Working", detail: "suit", updatedAt: 0),
            "code:9": Content(title: "Gone", status: "Working", updatedAt: 0),
            "call:abc": Content(title: "Call", status: "On the call", updatedAt: 0),
        ]
        let changes = LiveActivityPlan.changes(wanted: wanted, existing: existing, managing: [.code, .delegation], sessions: sessions, now: now)
        XCTAssertEqual(changes.update.map(\.key), ["code:1"])  // now needs you
        XCTAssertTrue(changes.start.isEmpty)
        XCTAssertEqual(Set(changes.end.keys), ["code:2", "code:9"])  // a call ends by its own push
        XCTAssertEqual(changes.end["code:2"]??.status, "Done")  // the last word, shown a while
        XCTAssertEqual(changes.end["code:9"], .some(nil))  // gone from the Mac: at once

        // Unchanged content (a new time only) is no update.
        let same = LiveActivityPlan.changes(wanted: wanted, existing: ["code:1": wanted[0].content.with(updatedAt: 5)], managing: [.code], now: now)
        XCTAssertTrue(same.update.isEmpty)
        XCTAssertTrue(same.end.isEmpty)
    }

    func testStartsOnlyInFrontAndNoMoreThanThree() {
        let sessions = (1...5).map { CodeSessionSummary(id: $0, title: "S\($0)", project: "p", status: .working) }
        let wanted = LiveActivityPlan.wanted(sessions: sessions, delegations: [], now: now)
        let started = LiveActivityPlan.changes(wanted: wanted, existing: [:], managing: [.code], now: now)
        XCTAssertEqual(started.start.count, LiveActivityPlan.limit)
        let background = LiveActivityPlan.changes(wanted: wanted, existing: [:], managing: [.code], now: now, canStart: false)
        XCTAssertTrue(background.start.isEmpty)
        // Delegations aren't ended when their list wasn't fetched.
        let kept = LiveActivityPlan.changes(wanted: [], existing: ["delegation:d1": Content(title: "x", status: "y", updatedAt: 0)], managing: [.code], now: now)
        XCTAssertTrue(kept.end.isEmpty)
    }

    func testCallAndVideoPushes() throws {
        let call = JarvisPush(kind: .call, id: "a1b2c3d4", title: "Calling Dr. Chen’s office", body: "To book a cleaning")
        let (start, ends) = try XCTUnwrap(LiveActivityPlan.fromPush(call, existing: [], now: now))
        XCTAssertFalse(ends)
        XCTAssertEqual(start.key, "call:a1b2c3d4")
        XCTAssertEqual(start.content.title, "Calling Dr. Chen’s office")
        XCTAssertEqual(start.content.status, "On the call")

        // The Mac doesn't follow a call as it goes: its next push is how it went.
        let outcome = JarvisPush(kind: .call, id: "a1b2c3d4", title: "Call finished", body: "Booked for Thursday at 10")
        let (last, ended) = try XCTUnwrap(LiveActivityPlan.fromPush(outcome, existing: ["call:a1b2c3d4"], now: now))
        XCTAssertTrue(ended)
        XCTAssertEqual(last.content.status, "Call ended")
        XCTAssertEqual(last.content.detail, "Booked for Thursday at 10")

        let video = try XCTUnwrap(LiveActivityPlan.fromPush(JarvisPush(kind: .video, id: "2", title: ""), existing: [], now: now))
        XCTAssertEqual(video.item.content.title, "Video summary")
        XCTAssertEqual(video.item.content.status, "Transcribing")

        XCTAssertNil(LiveActivityPlan.fromPush(JarvisPush(kind: .approval, id: "x"), existing: [], now: now))
        XCTAssertNil(LiveActivityPlan.fromPush(JarvisPush(kind: .call, id: ""), existing: [], now: now))
    }
}

private extension JarvisActivityAttributes.ContentState {
    func with(updatedAt: Double) -> Self {
        var copy = self
        copy.updatedAt = updatedAt
        return copy
    }
}
