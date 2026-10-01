import XCTest
@testable import JarvisCompanion

/// What Siri, Shortcuts and the Action Button say back, whatever the Mac does.
final class IntentTests: XCTestCase {
    private func client(
        ask: @escaping @Sendable (String, TimeInterval) async throws -> AskResult = { _, _ in AskResult(reply: "", done: true) },
        command: @escaping @Sendable (MacCommand) async throws -> Void = { _ in },
        digest: @escaping @Sendable () async throws -> Digest = { Digest(items: []) },
        kept: KeptBox = KeptBox(),
        wake: @escaping @Sendable () async -> Bool = { false }
    ) -> IntentRunner.Client {
        IntentRunner.Client(ask: ask, command: command, digest: digest, keep: { item in kept.items.append(item) }, wake: wake, pause: { _ in })
    }

    func testAskGivesTheReplyInWordsToSpeak() async {
        let reply = await IntentRunner.ask("Weather?", client: client(ask: { text, timeout in
            XCTAssertEqual(text, "Weather?")
            XCTAssertEqual(timeout, IntentRunner.waitForReply)
            return AskResult(reply: "**Clear**, 18°. See [the forecast](https://example.com).", done: true)
        }))
        XCTAssertEqual(reply, "Clear, 18°. See the forecast.")
        let empty = await IntentRunner.ask("Stop the music", client: client())
        XCTAssertEqual(empty, "Done.")
    }

    func testAskSaysWhyThereIsNoReplyYet() async {
        let approval = await IntentRunner.ask("Email Pepper", client: client(ask: { _, _ in
            AskResult(reply: "", done: false, approvals: [Approval(id: "a", question: "Send it?")])
        }))
        XCTAssertEqual(approval, "Jarvis needs your OK first. It’s waiting on your iPhone.")
        let slow = await IntentRunner.ask("Research this", client: client(ask: { _, _ in throw JarvisError.timedOut }))
        XCTAssertEqual(slow, "Jarvis is still working on that. The answer will be in the app.")
        let working = await IntentRunner.ask("Research this", client: client(ask: { _, _ in AskResult(reply: "Partial", done: false) }))
        XCTAssertEqual(working, "Jarvis is still working on that. The answer will be in the app.")
        let busy = await IntentRunner.ask("Again", client: client(ask: { _, _ in throw JarvisError.busy("") }))
        XCTAssertEqual(busy, "Jarvis is still on your last request. Try again in a moment.")
        let unpaired = await IntentRunner.ask("Hi", client: client(ask: { _, _ in throw JarvisError.unpaired }))
        XCTAssertTrue(unpaired.contains("pair again"))
        let none = await IntentRunner.ask("Hi", client: nil)
        XCTAssertEqual(none, IntentRunner.notPaired)
    }

    func testAnUnreachableMacKeepsTheQuestion() async {
        let kept = KeptBox()
        let reply = await IntentRunner.ask("Remind me to call Pepper", client: client(ask: { _, _ in throw JarvisError.unreachable("down") }, kept: kept))
        XCTAssertEqual(reply, "Your Mac isn’t reachable. I’ll send it when it’s back, within the hour.")
        XCTAssertEqual(kept.items.map(\.question), ["Remind me to call Pepper"])
    }

    func testAQuitJarvisIsOpenedOnTheMacAndAskedOnceItAnswers() async {
        let tries = Counter()
        let reply = await IntentRunner.ask("Weather?", client: client(ask: { _, timeout in
            let n = tries.next()
            if n < 3 { throw JarvisError.unreachable("refused") }  // quit, then opening
            XCTAssertLessThan(timeout, IntentRunner.waitForReply)  // what's left of Siri's wait
            return AskResult(reply: "Clear, 18°.", done: true)
        }, wake: { true }))
        XCTAssertEqual(reply, "Clear, 18°.")
        XCTAssertEqual(tries.value, 3)
    }

    func testAMacThatDoesntComeUpInTimeKeepsTheQuestion() async {
        let kept = KeptBox()
        let tries = Counter()
        let reply = await IntentRunner.ask("Remind me", client: client(ask: { _, _ in
            _ = tries.next()
            throw JarvisError.unreachable("down")
        }, kept: kept, wake: { true }))
        XCTAssertEqual(reply, "Your Mac isn’t reachable. I’ll send it when it’s back, within the hour.")
        XCTAssertEqual(kept.items.map(\.question), ["Remind me"])
        XCTAssertEqual(tries.value, 1 + 8)  // the first, then every 2 s for 15 s
    }

    func testBriefingDigestAndCommands() async {
        let briefing = await IntentRunner.brief(client: client(ask: { text, _ in
            XCTAssertEqual(text, "Brief me.")
            throw JarvisError.timedOut
        }))
        XCTAssertEqual(briefing, "Your briefing is on its way. It’ll be in J.A.R.V.I.S. in a moment.")

        let digest = await IntentRunner.whatDidIMiss(client: client(digest: {
            Digest(items: [DigestItem(who: "Pepper", kind: .text, summary: "Dinner at 8", at: nil, urgent: false)])
        }))
        XCTAssertEqual(digest, "One thing in the last day. Message from Pepper: Dinner at 8.")
        let away = await IntentRunner.whatDidIMiss(client: client(digest: { throw JarvisError.unreachable("x") }))
        XCTAssertEqual(away, "Your Mac isn’t reachable right now, so I can’t check.")

        let sent = CommandBox()
        let stopped = await IntentRunner.run(.stop, client: client(command: { sent.commands.append($0) }))
        XCTAssertEqual(stopped, "Stopped.")
        let notes = await IntentRunner.run(.meetingStart(title: "Meeting"), client: client(command: { sent.commands.append($0) }))
        XCTAssertEqual(notes, "Taking meeting notes on your Mac.")
        XCTAssertEqual(sent.commands, [.stop, .meetingStart(title: "Meeting")])
        // About this moment: never kept for later.
        let kept = KeptBox()
        let unreachable = await IntentRunner.run(.meetingStop, client: client(command: { _ in throw JarvisError.unreachable("x") }, kept: kept))
        XCTAssertEqual(unreachable, "Your Mac isn’t reachable right now.")
        XCTAssertTrue(kept.items.isEmpty)
    }

    func testLongRepliesAreCutAtASentence() {
        let long = String(repeating: "Jarvis found another detail worth mentioning. ", count: 40)
        let spoken = IntentRunner.spoken(long)
        XCTAssertLessThanOrEqual(spoken.count, IntentRunner.longestSpoken + 30)
        XCTAssertTrue(spoken.hasSuffix("mentioning. The rest is in the app."))
    }
}

final class KeptBox: @unchecked Sendable {
    var items: [OutboxItem] = []
}

final class CommandBox: @unchecked Sendable {
    var commands: [MacCommand] = []
}

/// Counts calls from @Sendable closures.
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    /// The number of calls so far, this one included.
    func next() -> Int { lock.withLock { count += 1; return count } }
}
