import XCTest
@testable import JarvisCompanion

/// Replies as they're spoken, on the iPhone and the Watch.
final class SpeakableTests: XCTestCase {
    func testMarkdownAndLinksAreNotReadAloud() {
        XCTAssertEqual(Speakable.clean("**Done.** See [the doc](https://example.com/x) or https://example.com."), "Done. See the doc or")
        XCTAssertEqual(Speakable.clean("# Plan\n- one\n- `two`"), "Plan one two")
    }

    func testALongReplyStopsAtASentence() {
        let long = String(repeating: "This is one sentence of the reply. ", count: 80)
        let spoken = Speakable.clean(long)
        XCTAssertLessThanOrEqual(spoken.count, 1500)
        XCTAssertTrue(spoken.hasSuffix("."))
    }

    /// The Watch's own voice, when the Mac can't voice a reply, speaks the reply's language.
    func testTheWatchsOwnVoiceSpeaksTheReplysLanguage() {
        let english = ["en-GB", "zh-Hans-CN"]
        XCTAssertEqual(Speakable.voiceLanguage(for: "Your next meeting is at three.", preferred: english), "en-GB")
        XCTAssertEqual(Speakable.voiceLanguage(for: "你的下一个会议在三点。", preferred: english), "zh-CN")
        // Chinese that names things in English is still Chinese; English that names someone
        // in Chinese is still English.
        XCTAssertEqual(Speakable.voiceLanguage(for: "好的，Jarvis Code 会先跑 npm test。", preferred: ["en-US"]), "zh-CN")
        XCTAssertEqual(Speakable.voiceLanguage(for: "Dinner with 王芳 moved to eight.", preferred: ["en-US"]), "en-US")
    }

    func testTheirOwnChineseOrEnglishElseTheDefaults() {
        XCTAssertEqual(Speakable.voiceLanguage(for: "好的。", preferred: ["zh-Hant-TW", "en-US"]), "zh-TW")
        XCTAssertEqual(Speakable.voiceLanguage(for: "好的。", preferred: ["zh-Hant-HK"]), "zh-HK")
        XCTAssertEqual(Speakable.voiceLanguage(for: "好的。", preferred: ["zh-Hant"]), "zh-TW")
        XCTAssertEqual(Speakable.voiceLanguage(for: "好的。", preferred: ["en_US"]), "zh-CN")
        XCTAssertEqual(Speakable.voiceLanguage(for: "Done.", preferred: ["zh-Hans-CN", "en-AU"]), "en-AU")
        // Jarvis speaks English or Chinese: a French phone still hears English in English.
        XCTAssertEqual(Speakable.voiceLanguage(for: "Done.", preferred: ["fr-FR"]), "en-US")
        XCTAssertEqual(Speakable.voiceLanguage(for: "Done.", preferred: []), "en-US")
    }
}
