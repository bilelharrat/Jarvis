import XCTest
@testable import JarvisCompanion

/// The offline outbox: kept on disk, an hour at most, sent in order when the Mac is back.
final class OutboxTests: XCTestCase {
    private var directory: URL!
    private var clock: TestClock!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString)", directoryHint: .isDirectory)
        clock = TestClock(Date(timeIntervalSince1970: 1_790_000_000))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func outbox() -> Outbox {
        let clock = clock!
        return Outbox(directory: directory, now: { clock.now })
    }

    func testKeepsRequestsInOrderAcrossInstances() throws {
        let box = outbox()
        try box.add(.ask("What's the weather?", at: clock.now))
        try box.add(.command(.briefing, label: "Brief me", at: clock.now))
        // Another process (the share extension) sees the same queue.
        let other = outbox()
        XCTAssertEqual(other.items().map(\.kind), [.ask, .command])
        XCTAssertEqual(other.items().first?.question, "What's the weather?")
        XCTAssertEqual(other.items().last?.body, ["type": "briefing"])
    }

    func testExpiresAfterAnHour() throws {
        let box = outbox()
        try box.add(.ask("Old question", at: clock.now))
        clock.now += 59 * 60
        try box.add(.ask("New question", at: clock.now))
        XCTAssertEqual(box.items().count, 2)
        clock.now += 61
        XCTAssertEqual(box.items().map(\.question), ["New question"])  // an hour and a second: gone
        XCTAssertEqual(box.pruneExpired(), 1)
        XCTAssertEqual(outbox().items().count, 1)
    }

    func testTheLatestLocationReplacesOlderOnesButArrivalsStay() throws {
        let box = outbox()
        let fix = { (lat: Double) in LocationReport(latitude: lat, longitude: 0, accuracy: 10, at: self.clock.now) }
        try box.add(.location(fix(1), at: clock.now))
        try box.add(.location(LocationReport(latitude: 2, longitude: 0, accuracy: 10, at: clock.now, event: .arrive, region: .home), at: clock.now))
        try box.add(.location(fix(3), at: clock.now))
        try box.add(.health(HealthDay(day: "2026-09-28", steps: 1), at: clock.now))
        try box.add(.health(HealthDay(day: "2026-09-28", steps: 2), at: clock.now))
        let items = box.items()
        XCTAssertEqual(items.map(\.label), ["Arrived home", "Your location", "Health summary for 2026-09-28"])
        XCTAssertEqual(items[1].body["lat"]?.doubleValue, 3)
        XCTAssertEqual(items[2].body["steps"]?.doubleValue, 2)
    }

    func testAShareKeepsItsDataInAFileAndCleansUp() throws {
        let box = outbox()
        let data = Data(repeating: 7, count: 3000)
        let share = ShareItem(kind: .image, name: "photo.jpg", data: data, note: "What is this?")
        let item = OutboxItem.share(share, at: clock.now)
        try box.add(item, payload: data)
        let stored = try XCTUnwrap(box.items().first)
        XCTAssertEqual(stored.label, "Shared: photo.jpg")
        let file = try XCTUnwrap(stored.payloadFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appending(path: file).path))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: box.body(for: stored)) as? [String: Any])
        XCTAssertEqual(body["kind"] as? String, "image")
        XCTAssertEqual(body["note"] as? String, "What is this?")
        XCTAssertEqual((body["data_base64"] as? String).flatMap { Data(base64Encoded: $0) }, data)
        box.remove(stored.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appending(path: file).path))
    }

    func testADamagedFileReadsAsWhatStillMakesSense() throws {
        let box = outbox()
        try box.add(.ask("Keep me", at: clock.now))
        let url = directory.appending(path: "outbox.json")
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [Any])
        raw.append(["id": "not a uuid", "kind": "ask"])
        try JSONSerialization.data(withJSONObject: raw).write(to: url)
        XCTAssertEqual(box.items().map(\.question), ["Keep me"])
        try Data("{not json".utf8).write(to: url)
        XCTAssertEqual(box.items(), [])
    }

    func testDrainSendsInOrderAndStopsWhenTheMacGoesAway() async throws {
        let box = outbox()
        try box.add(.ask("First", at: clock.now))
        try box.add(.command(.runRoutine(id: "r1"), label: "Routine", at: clock.now))
        try box.add(.ask("Third", at: clock.now))
        let log = SendLog(outcomes: [.delivered(reply: "Answer one"), .unreachable])
        let report = await OutboxSender.drain(box) { item, _ in await log.send(item) }
        let sent = await log.sent
        XCTAssertEqual(sent, ["First", "Routine"])  // stopped at the routine: the Mac went away
        XCTAssertEqual(report.sent.map(\.label), ["First"])
        XCTAssertEqual(Array(report.replies.values), ["Answer one"])
        XCTAssertEqual(report.remaining, 2)
        XCTAssertEqual(box.items().map(\.label), ["Routine", "Third"])
        XCTAssertEqual(box.items().first?.attempts, 1)
    }

    func testRefusedRequestsAreDroppedAndBusyOnesWait() async throws {
        let box = outbox()
        try box.add(.ask("Busy one", at: clock.now))
        try box.add(.command(.briefing, label: "Brief me", at: clock.now))
        try box.add(.codeSend(session: 4, text: "Also add tests", title: "Fix login", at: clock.now))
        let log = SendLog(outcomes: [.later, .refused, .delivered(reply: nil)])
        let report = await OutboxSender.drain(box) { item, _ in await log.send(item) }
        XCTAssertEqual(report.refused.map(\.label), ["Brief me"])
        XCTAssertEqual(report.sent.map(\.label), ["Fix login: Also add tests"])
        XCTAssertEqual(box.items().map(\.label), ["Busy one"])
        XCTAssertEqual(report.remaining, 1)
    }

    /// The app's own drain and background refresh's can start at the same moment (a push
    /// or the app coming to the front during a refresh): each request still goes once.
    func testTwoDrainsAtOnceSendEachRequestOnce() async throws {
        let box = outbox()
        try box.add(.command(.runRoutine(id: "r1"), label: "Routine", at: clock.now))
        try box.add(.codeSend(session: 4, text: "Also add tests", title: "Fix login", at: clock.now))
        let log = SlowLog()
        async let first = OutboxSender.drain(box) { item, _ in await log.send(item) }
        async let second = OutboxSender.drain(box) { item, _ in await log.send(item) }
        _ = await (first, second)
        let sent = await log.sent
        XCTAssertEqual(sent.sorted(), ["Fix login: Also add tests", "Routine"])
        XCTAssertTrue(box.items().isEmpty)
    }

    /// A question the Mac is too busy for keeps its place: a later question waits behind it
    /// (the Mac may be free by the time the next one goes), while other requests go on.
    func testABusyQuestionIsNotOvertakenByALaterOne() async throws {
        let box = outbox()
        try box.add(.ask("First", at: clock.now))
        try box.add(.ask("Second", at: clock.now))
        try box.add(.command(.briefing, label: "Brief me", at: clock.now))
        let log = SendLog(outcomes: [.later, .delivered(reply: nil), .delivered(reply: nil)])
        let report = await OutboxSender.drain(box) { item, _ in await log.send(item) }
        let sent = await log.sent
        XCTAssertEqual(sent, ["First", "Brief me"])
        XCTAssertEqual(box.items().compactMap(\.question), ["First", "Second"])
        XCTAssertEqual(report.remaining, 2)
    }

    func testDrainDropsExpiredFirst() async throws {
        let box = outbox()
        try box.add(.ask("Too old", at: clock.now))
        clock.now += OutboxItem.lifetime + 1
        let log = SendLog(outcomes: [])
        let report = await OutboxSender.drain(box) { item, _ in await log.send(item) }
        XCTAssertEqual(report.expired, 1)
        let sent = await log.sent
        XCTAssertTrue(sent.isEmpty)
    }

    func testOutcomesFollowTheErrors() async {
        let outcome = { (error: Error) in await OutboxSender.outcome { throw error } }
        let cases: [(Error, OutboxSender.Outcome)] = [
            (JarvisError.unreachable("x"), .unreachable),
            (JarvisError.certificateMismatch, .unreachable),
            (JarvisError.timedOut, .delivered(reply: nil)),  // the Mac has it and carries on
            (JarvisError.connectionLost, .delivered(reply: nil)),
            (JarvisError.busy(""), .later),
            (JarvisError.rejected("no"), .refused),
            (JarvisError.tooBig, .refused),
            (JarvisError.unpaired, .unreachable),
        ]
        for (error, expected) in cases {
            let result = await outcome(error)
            XCTAssertEqual(result, expected, "\(error)")
        }
        let delivered = await OutboxSender.outcome { "Reply" }
        XCTAssertEqual(delivered, .delivered(reply: "Reply"))
    }
}

final class TestClock: @unchecked Sendable {
    var now: Date
    init(_ now: Date) { self.now = now }
}

/// Records what's sent, taking a moment over each, as the Mac would.
private actor SlowLog {
    private(set) var sent: [String] = []

    func send(_ item: OutboxItem) async -> OutboxSender.Outcome {
        sent.append(item.question ?? item.label)
        try? await Task.sleep(for: .milliseconds(300))
        return .delivered(reply: nil)
    }
}

private actor SendLog {
    private var outcomes: [OutboxSender.Outcome]
    private(set) var sent: [String] = []

    init(outcomes: [OutboxSender.Outcome]) {
        self.outcomes = outcomes
    }

    func send(_ item: OutboxItem) -> OutboxSender.Outcome {
        sent.append(item.question ?? item.label)
        return outcomes.isEmpty ? .delivered(reply: nil) : outcomes.removeFirst()
    }
}
