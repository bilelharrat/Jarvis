import XCTest
@testable import JarvisCompanion

/// Voice mode: replies spoken sentence by sentence as they're written, and the owner told
/// apart from Jarvis's own voice coming back through the microphone.
final class VoiceModeTests: XCTestCase {
    func testFinishedSentencesAreSpokenAsTheyCome() {
        var (pieces, next) = VoicePlayer.sentences(in: "The weather today is sunny. Highs of", from: 0, final: false)
        XCTAssertEqual(pieces, ["The weather today is sunny."])
        (pieces, next) = VoicePlayer.sentences(in: "The weather today is sunny. Highs of 24 degrees. Enjoy", from: next, final: false)
        XCTAssertEqual(pieces, ["Highs of 24 degrees."])
        (pieces, next) = VoicePlayer.sentences(in: "The weather today is sunny. Highs of 24 degrees. Enjoy it!", from: next, final: true)
        XCTAssertEqual(pieces, ["Enjoy it!"])
        XCTAssertEqual(next, "The weather today is sunny. Highs of 24 degrees. Enjoy it!".count)
    }

    func testShortSentencesWaitForTheNextAndNumbersDontSplit() {
        let (pieces, next) = VoicePlayer.sentences(in: "Yes. It costs 3.50 dollars today. And", from: 0, final: false)
        XCTAssertEqual(pieces, ["Yes. It costs 3.50 dollars today."])  // "Yes." alone is too short
        XCTAssertEqual(VoicePlayer.sentences(in: "Hi", from: 0, final: false).0, [])
        XCTAssertEqual(next, "Yes. It costs 3.50 dollars today.".count)
        XCTAssertEqual(VoicePlayer.sentences(in: "", from: 0, final: true).0, [])
    }

    func testJarvissOwnEchoIsntTheOwner() {
        let reply = "Your next meeting is with Sarah at three, about the launch plan."
        XCTAssertFalse(BargeIn.isOwner(heard: "next meeting is with Sarah", reply: reply))
        XCTAssertFalse(BargeIn.isOwner(heard: "wait", reply: reply))  // one word could be noise
        XCTAssertTrue(BargeIn.isOwner(heard: "hold on cancel that", reply: reply))
        XCTAssertTrue(BargeIn.isOwner(heard: "no, move it to Friday instead", reply: reply))
    }

    func testTheReplysTailIsShown() {
        XCTAssertEqual(VoiceModeView.tail("One. Two. Three."), "Two. Three")
        XCTAssertEqual(VoiceModeView.tail("Just this"), "Just this")
    }
}
