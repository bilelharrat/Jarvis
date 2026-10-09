import UIKit
import XCTest
@testable import JarvisCompanion

final class MacAddressTests: XCTestCase {
    func testAddsSchemeAndDefaultPort() {
        XCTAssertEqual(MacAddress.normalize("192.168.1.20")?.absoluteString, "https://192.168.1.20:8765")
        XCTAssertEqual(MacAddress.normalize("  Bilels-MacBook.local ")?.absoluteString, "https://Bilels-MacBook.local:8765")
        XCTAssertEqual(MacAddress.normalize("100.101.102.103")?.absoluteString, "https://100.101.102.103:8765")
    }

    func testKeepsAGivenPortAndAlwaysSpeaksTLS() {
        XCTAssertEqual(MacAddress.normalize("mac.local:8766")?.absoluteString, "https://mac.local:8766")
        XCTAssertEqual(MacAddress.normalize("http://100.64.0.7")?.absoluteString, "https://100.64.0.7:8765")
        XCTAssertEqual(MacAddress.normalize("HTTP://10.0.0.2:9000/")?.absoluteString, "https://10.0.0.2:9000")
        XCTAssertEqual(MacAddress.normalize("https://mac.tail1234.ts.net")?.absoluteString, "https://mac.tail1234.ts.net:8765")
    }

    func testDropsPathsAndHandlesIPv6() {
        XCTAssertEqual(MacAddress.normalize("192.168.1.20:8765/api/state")?.absoluteString, "https://192.168.1.20:8765")
        XCTAssertEqual(MacAddress.normalize("[fe80::1]:8766")?.absoluteString, "https://[fe80::1]:8766")
        XCTAssertEqual(MacAddress.normalize("fd7a:115c::1")?.absoluteString, "https://[fd7a:115c::1]:8765")
    }

    func testRejectsNonsense() {
        XCTAssertNil(MacAddress.normalize(""))
        XCTAssertNil(MacAddress.normalize("my mac"))
        XCTAssertNil(MacAddress.normalize("ftp://mac.local"))
        XCTAssertNil(MacAddress.normalize("mac.local:notaport"))
        XCTAssertNil(MacAddress.normalize("mac.local:70000"))
        XCTAssertNil(MacAddress.normalize("user@mac.local"))
    }

    func testDisplay() throws {
        let url = try XCTUnwrap(MacAddress.normalize("192.168.1.20"))
        XCTAssertEqual(MacAddress.display(url), "192.168.1.20:8765")
    }
}

final class DecodingTests: XCTestCase {
    func testDecodesTheMacsState() throws {
        let json = """
        {"state": "thinking", "turn": {"user": "what's next", "reply": "Next up"},
         "approvals": [{"id": "a1b2", "question": "Send this?", "detail": "To: Pepper",
                        "choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "Don't send"}],
                        "ask_kind": "question", "task_id": 3}],
         "history": [{"role": "user", "text": "hi", "at": "2026-09-29T14:30:05"},
                     {"role": "assistant", "text": "Hello.", "at": "2026-09-29T14:30:09"}],
         "weather": {"city": "Malibu", "temp": 18, "unit": "°C", "summary": "mainly clear", "code": 1, "high": 21, "low": null},
         "next_event": {"title": "Design review", "begin": "2026-09-29T15:00", "location": ""},
         "tasks": [{"id": 3, "label": "Eden Code · suit", "title": "Refactor", "status": "running", "last_action": "Tests"},
                   {"id": "x", "status": "done"}],
         "meeting": null,
         "routines": [{"id": "r1", "name": "Morning"}, {"name": "no id"}],
         "model": "Opus 5.5"}
        """
        let state = try JSONDecoder().decode(RemoteState.self, from: Data(json.utf8))
        XCTAssertEqual(state.state, .thinking)
        XCTAssertEqual(state.turn.reply, "Next up")
        XCTAssertEqual(state.approvals.first?.choices.map(\.label), ["Send", "Don't send"])
        XCTAssertEqual(state.approvals.first?.negative.id, "deny")
        XCTAssertEqual(state.history.count, 2)
        XCTAssertNotNil(state.history[0].date)
        XCTAssertEqual(state.weather?.headline, "18°C · Mainly clear")
        XCTAssertNil(state.weather?.low)
        XCTAssertNotNil(state.nextEvent?.date)
        XCTAssertEqual(state.tasks.map(\.id), ["3", "x"])
        XCTAssertEqual(state.activeTasks.count, 1)
        XCTAssertNil(state.meeting)
        XCTAssertEqual(state.routines.map(\.id), ["r1"])  // the one without an id is skipped
        XCTAssertEqual(state.model, "Opus 5.5")
    }

    func testToleratesMissingAndStrangeFields() throws {
        let state = try JSONDecoder().decode(RemoteState.self, from: Data(#"{"state": "dreaming", "approvals": null, "weather": {"city": "Nowhere", "error": "I couldn't find that place."}}"#.utf8))
        XCTAssertEqual(state.state, .unknown)
        XCTAssertTrue(state.approvals.isEmpty)
        XCTAssertEqual(state.weather?.isAvailable, false)
        XCTAssertTrue(state.history.isEmpty)
    }

    func testAskResultAndDefaultChoices() throws {
        let result = try JSONDecoder().decode(AskResult.self, from: Data(#"{"reply": "", "done": false, "approvals": [{"id": "q1", "question": "OK?"}]}"#.utf8))
        XCTAssertFalse(result.done)
        XCTAssertEqual(result.approvals.first?.choices.map(\.id), ["allow", "deny"])
    }

    func testNegativeChoices() {
        XCTAssertTrue(ApprovalChoice(id: "deny", label: "Not now").isNegative)
        XCTAssertTrue(ApprovalChoice(id: "x", label: "Don’t send").isNegative)
        XCTAssertFalse(ApprovalChoice(id: "always", label: "Always").isNegative)
        XCTAssertFalse(ApprovalChoice(id: "allow", label: "Send").isNegative)
    }
}

final class PendingRequestTests: XCTestCase {
    private let earlier = [
        HistoryItem(role: .user, text: "What's next?", at: "2026-09-29T10:00:00"),
        HistoryItem(role: .assistant, text: "Standup at 10:30.", at: "2026-09-29T10:00:03"),
    ]

    func testAnEarlierIdenticalQuestionIsNotThisOne() {
        let request = PendingRequest(question: "What's next?", history: earlier)
        XCTAssertNil(request.echo(in: earlier))
        let later = earlier + [HistoryItem(role: .user, text: "What's next?", at: "2026-09-29T14:00:00")]
        XCTAssertEqual(request.echo(in: later), 2)
    }

    func testAWaitingRequestFinishesFromHistory() {
        var request = PendingRequest(question: "Email Pepper", history: earlier)
        request.phase = .waiting
        var state = RemoteState()
        state.state = .thinking
        state.history = earlier + [HistoryItem(role: .user, text: "Email Pepper", at: "2026-09-29T14:00:00")]
        XCTAssertNil(request.follow(state))
        XCTAssertTrue(request.isOpen)
        state.state = .idle
        state.history.append(HistoryItem(role: .assistant, text: "Sent.", at: "2026-09-29T14:00:20"))
        XCTAssertEqual(request.follow(state), "Sent.")
        XCTAssertEqual(request.reply, "Sent.")
        XCTAssertTrue(request.isSettled(by: state.history))
    }

    func testAFailedSendThatReachedTheMacRecovers() {
        var request = PendingRequest(question: "Weather?", history: [])
        request.phase = .failed("Can’t reach the Mac")
        var state = RemoteState()
        state.state = .thinking
        state.history = [HistoryItem(role: .user, text: "Weather?", at: "2026-09-29T14:00:00")]
        XCTAssertNil(request.follow(state))
        XCTAssertTrue(request.isOpen)
        state.state = .idle
        state.history.append(HistoryItem(role: .assistant, text: "Clear, 18°.", at: "2026-09-29T14:00:04"))
        XCTAssertEqual(request.follow(state), "Clear, 18°.")
    }

    func testAStoppedTurnFinishesEmpty() {
        var request = PendingRequest(question: "Long thing", history: [])
        request.phase = .waiting
        var state = RemoteState()
        state.state = .idle
        state.history = [HistoryItem(role: .user, text: "Long thing", at: "2026-09-29T14:00:00")]
        XCTAssertEqual(request.follow(state), "")
    }
}

final class TranscriptTests: XCTestCase {
    func testShowsThePendingQuestionUntilTheMacHasIt() {
        let request = PendingRequest(question: "Weather?", history: [])
        var lines = Transcript.lines(state: RemoteState(), pending: request)
        XCTAssertEqual(lines.map(\.kind), [.user, .jarvis])
        XCTAssertTrue(lines[0].sending)
        XCTAssertTrue(lines[1].live)

        var state = RemoteState()
        state.state = .thinking
        state.turn = Turn(user: "Weather?", reply: "It's 18")
        state.history = [HistoryItem(role: .user, text: "Weather?", at: "2026-09-29T14:00:00")]
        lines = Transcript.lines(state: state, pending: request)
        XCTAssertEqual(lines.map(\.kind), [.user, .jarvis])  // no duplicate question
        XCTAssertEqual(lines[1].text, "It's 18")
    }

    func testQuestionsWaitingForTheMacShowAfterTheConversation() {
        var state = RemoteState()
        state.history = [HistoryItem(role: .user, text: "Hi", at: "2026-09-29T14:00:00"), HistoryItem(role: .assistant, text: "Hello.", at: "2026-09-29T14:00:02")]
        let asked = Date(timeIntervalSince1970: 1_790_000_000)
        let lines = Transcript.lines(state: state, pending: nil, queued: [.ask("Weather tomorrow?", at: asked), .command(.briefing, label: "Brief me")])
        XCTAssertEqual(lines.map(\.kind), [.user, .jarvis, .user])  // the briefing isn't a line of the conversation
        XCTAssertTrue(lines[2].waiting)
        XCTAssertEqual(lines[2].text, "Weather tomorrow?")
        XCTAssertEqual(lines[2].time, asked)
        XCTAssertFalse(lines[0].waiting)
    }

    func testShowsAMacTurnInProgress() {
        var state = RemoteState()
        state.state = .speaking
        state.turn = Turn(user: "Morning briefing", reply: "Good morning")
        state.history = [HistoryItem(role: .user, text: "Morning briefing", at: "2026-09-29T08:00:00")]
        let lines = Transcript.lines(state: state, pending: nil)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[1].text, "Good morning")
        XCTAssertTrue(lines[1].live)
    }

    func testPicturesSentWithAQuestionShowOnItsLine() {
        let thumbs = [Data([1, 2]), Data([3])]
        let request = PendingRequest(question: "Compare these", history: [])
        var lines = Transcript.lines(state: RemoteState(), pending: request, pictures: ["Compare these": thumbs])
        XCTAssertEqual(lines[0].pictures, thumbs)
        XCTAssertEqual(lines[1].pictures, [])  // not Jarvis's answer

        var state = RemoteState()
        state.history = [
            HistoryItem(role: .user, text: "Hi", at: "2026-09-29T14:00:00"),
            HistoryItem(role: .assistant, text: "Hello.", at: "2026-09-29T14:00:02"),
            HistoryItem(role: .user, text: "Compare these", at: "2026-09-29T14:01:00"),
            HistoryItem(role: .assistant, text: "The left one is newer.", at: "2026-09-29T14:01:09"),
        ]
        lines = Transcript.lines(state: state, pending: nil, pictures: ["Compare these": thumbs])
        XCTAssertEqual(lines.map(\.pictures), [[], [], thumbs, []])  // still there once the Mac has it
    }
}

final class PictureTests: XCTestCase {
    func testSeveralPicturesGoAsOneList() throws {
        let body = try JarvisAPI.photosBody(jpegs: [Data([0xFF, 0xD8]), Data([0xFF, 0xD9])], question: "  Which is newer? ")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["question"] as? String, "Which is newer?")
        XCTAssertEqual(json["images_base64"] as? [String], ["/9g=", "/9k="])
        XCTAssertNil(json["data_base64"])

        let bare = try JarvisAPI.photosBody(jpegs: [Data([1]), Data([2])], question: nil)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: bare) as? [String: [String]], ["images_base64": ["AQ==", "Ag=="]])
    }

    func testAQuestionWithOnlyPicturesStillAsksSomething() {
        XCTAssertEqual(PhotoQuestion.fallback(count: 1), "What is this?")
        XCTAssertEqual(PhotoQuestion.fallback(count: 3), "What’s in these pictures?")
    }

    func testAPictureKeepsASmallCopyForTheScreen() throws {
        let big = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        let attachment = try XCTUnwrap(Attachment(image: big))
        let thumb = try XCTUnwrap(UIImage(data: attachment.thumbnail))
        XCTAssertLessThanOrEqual(max(thumb.size.width, thumb.size.height) * thumb.scale, 240)
        XCTAssertEqual(attachment.image, big)  // what's sent is prepared from the full picture
    }
}

/// The app hosting these tests stays still (no pairing, polling, background refresh or
/// pushes), so nothing reaches whatever Mac this Simulator is paired with.
final class TestHostTests: XCTestCase {
    func testTheHostKnowsItIsHostingUnitTests() {
        XCTAssertTrue(TestHost.isRunningUnitTests)
    }
}
