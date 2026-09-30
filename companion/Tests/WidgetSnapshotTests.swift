import XCTest
@testable import JarvisCompanion

/// What the widgets and complications show, built from the Mac's state and kept on disk.
final class WidgetSnapshotTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func state() throws -> RemoteState {
        try JSONDecoder().decode(RemoteState.self, from: Data("""
        {"state": "thinking", "pending_approvals": 2,
         "approvals": [{"id": "c7", "question": "Run npm test?", "source": "code", "task_id": 4}],
         "next_event": {"title": "Design review", "begin": "2026-09-21T15:00"},
         "code_sessions": [
            {"id": 1, "title": "Docs", "project": "arc", "status": "done"},
            {"id": 2, "title": "Refactor", "project": "suit", "status": "working"},
            {"id": 3, "title": "Login bug", "project": "suit", "status": "needs_you"},
            {"id": 4, "title": "Old", "project": "x", "status": "idle"},
            {"id": 5, "title": "Older", "project": "x", "status": "resting"}
         ],
         "delegations_active": 1, "meeting": "Standup"}
        """.utf8))
    }

    func testBuiltFromTheMacsState() throws {
        let snapshot = WidgetSnapshot.from(try state(), macName: "Tony’s Mac", at: now)
        XCTAssertTrue(snapshot.online)
        XCTAssertEqual(snapshot.macName, "Tony’s Mac")
        XCTAssertEqual(snapshot.pendingApprovals, 2)
        XCTAssertEqual(snapshot.approvalQuestion, "Run npm test?")
        XCTAssertTrue(snapshot.approvalFromCode)
        XCTAssertEqual(snapshot.nextEvent?.title, "Design review")
        XCTAssertNotNil(snapshot.nextEvent?.begin)
        // Needs you first, then working, then the rest; four at most.
        XCTAssertEqual(snapshot.codeSessions.map(\.id), [3, 2, 1, 4])
        XCTAssertEqual(snapshot.needsYouCount, 1)
        XCTAssertEqual(snapshot.workingCount, 1)
        XCTAssertEqual(snapshot.delegationsActive, 1)
        XCTAssertEqual(snapshot.meeting, "Standup")
        XCTAssertFalse(snapshot.isStale(at: now.addingTimeInterval(60)))
    }

    func testOnlyWhatIsShownDecidesAReload() throws {
        let first = WidgetSnapshot.from(try state(), macName: "Mac", at: now)
        let later = WidgetSnapshot.from(try state(), macName: "Mac", at: now.addingTimeInterval(120))
        XCTAssertTrue(later.looksTheSame(as: first))  // only the time differs
        XCTAssertFalse(later.looksTheSame(as: nil))
        var changed = try state()
        changed.pendingApprovals = 0
        XCTAssertFalse(WidgetSnapshot.from(changed, macName: "Mac", at: now).looksTheSame(as: first))
        // The Mac thinking, speaking and idling again isn't a reason to spend the reload budget.
        var idle = try state()
        idle.state = .idle
        XCTAssertTrue(WidgetSnapshot.from(idle, macName: "Mac", at: now).looksTheSame(as: first))
    }

    func testOfflineAndStale() throws {
        let snapshot = WidgetSnapshot.from(try state(), macName: "Mac", at: now)
        let offline = snapshot.offline()
        XCTAssertFalse(offline.online)
        XCTAssertTrue(offline.isStale(at: now))
        XCTAssertEqual(offline.pendingApprovals, snapshot.pendingApprovals)  // what was known stays
        XCTAssertTrue(snapshot.isStale(at: now.addingTimeInterval(46 * 60)))
        XCTAssertTrue(WidgetSnapshot.waiting(macName: "Mac").isStale(at: now))
    }

    func testStoreRoundTripsAndSaysWhenItChanged() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "snapshot-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = SnapshotStore(url: url)
        XCTAssertNil(store.read())
        let snapshot = WidgetSnapshot.from(try state(), macName: "Mac", at: now)
        XCTAssertTrue(store.write(snapshot))
        XCTAssertEqual(store.read(), snapshot)
        XCTAssertFalse(store.write(WidgetSnapshot.from(try state(), macName: "Mac", at: now.addingTimeInterval(60))))
        XCTAssertTrue(store.write(snapshot.offline()))
        try Data("not json".utf8).write(to: url)
        XCTAssertNil(store.read())  // a damaged file reads as none, never a crash
        store.clear()
        XCTAssertNil(store.read())
    }

    func testTheWatchGetsTheSnapshotIntact() throws {
        let snapshot = WidgetSnapshot.from(try state(), macName: "Mac", at: now)
        let info = try XCTUnwrap(WatchLink.userInfo(for: snapshot))
        XCTAssertEqual(WatchLink.snapshot(from: info), snapshot)
        XCTAssertNil(WatchLink.snapshot(from: ["snapshot": Data("x".utf8)]))
        XCTAssertNil(WatchLink.snapshot(from: [:]))
    }

    func testWidgetsRedrawWhenTheNextEventStartsAndWhenItGoesStale() throws {
        var snapshot = WidgetSnapshot.from(try state(), macName: "Mac", at: now)
        snapshot.nextEvent = .init(title: "Review", begin: now.addingTimeInterval(1800))
        XCTAssertEqual(SnapshotTimeline.dates(for: snapshot, now: now), [now, now.addingTimeInterval(1800), now.addingTimeInterval(45 * 60)])
        snapshot.nextEvent = .init(title: "Tomorrow", begin: now.addingTimeInterval(24 * 3600))
        XCTAssertEqual(SnapshotTimeline.dates(for: snapshot, now: now), [now, now.addingTimeInterval(45 * 60)])
        XCTAssertEqual(SnapshotTimeline.dates(for: snapshot.offline(), now: now), [now])
        XCTAssertEqual(SnapshotTimeline.dates(for: nil, now: now), [now])
    }
}
