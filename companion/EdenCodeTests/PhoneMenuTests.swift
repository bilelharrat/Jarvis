import XCTest
@testable import EdenCode

/// The fixes from the owner's TestFlight 2 screenshots that live in rules, not layout: the
/// model list as the Mac's model menu (Model Router first, providers under their headings,
/// friendly names, the session's model checked), the mode pill's short word, and the
/// drawer's quiet "Resting" instead of "Waiting".
final class PhoneMenuTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try LiveBackend.decode(T.self, Data(json.utf8))
    }

    func testModelRouterAndFriendlyNamesDecode() throws {
        let options = try decode(PhoneOptions.self, """
        {"models": [
          {"ref": "router", "name": "Model Router", "group": "", "note": "Picks the model and effort for each message",
           "needs_key": false, "router": true},
          {"ref": "claude:opus", "name": "Claude Opus 5.5", "group": "Anthropic Claude", "needs_key": false, "router": false},
          {"ref": "custom:k27h", "name": "kimi-k2.7-code-highspeed", "group": "Moonshot", "needs_key": false},
          {"ref": "custom:k26", "name": "kimi-k2.6 · Moonshot", "group": "Moonshot"}
        ],
         "modes": [{"id": "ask", "name": "Manual", "short": "Manual"}, {"id": "auto", "name": "Bypass permissions"}],
         "router": true, "defaults": {"model": "router", "mode": "ask"}}
        """)
        XCTAssertTrue(options.models[0].router)
        XCTAssertEqual(options.models[0].note, "Picks the model and effort for each message")
        XCTAssertFalse(options.models[1].router)
        // An older Mac's raw ids are worded.
        XCTAssertEqual(options.models[2].name, "Kimi K2.7 Code Highspeed")
        XCTAssertEqual(options.models[3].name, "Kimi K2.6 · Moonshot")
        XCTAssertEqual(options.defaultModel, "router")
        // The pill's short word: "Bypass", not "Bypass p…".
        XCTAssertEqual(options.modes.map(\.short), ["Manual", "Bypass"])
    }

    func testFriendlyNames() {
        XCTAssertEqual(ModelMenu.friendly("kimi-k2.7-code"), "Kimi K2.7 Code")
        XCTAssertEqual(ModelMenu.friendly("gpt-6.1-sol"), "GPT-6.1 Sol")
        XCTAssertEqual(ModelMenu.friendly("gpt-oss:20b"), "GPT-OSS 20B")
        XCTAssertEqual(ModelMenu.friendly("moonshotai/kimi-k2"), "Kimi K2")
        XCTAssertEqual(ModelMenu.friendly("Claude Opus 5.5"), "Claude Opus 5.5")  // a name stays
        XCTAssertEqual(ModelMenu.friendly("Model Router"), "Model Router")
        XCTAssertEqual(ModelMenu.friendly(""), "")
    }

    func testSectionsFollowTheMacsMenu() {
        let models = [
            PhoneOptions.Model(ref: "custom:qwen", name: "Qwen3", group: "On this Mac"),
            PhoneOptions.Model(ref: "custom:k26", name: "Kimi K2.6", group: "Moonshot"),
            PhoneOptions.Model(ref: "eden:gemini", name: "Gemini 4 Argon", group: "Google Gemini", needsKey: true),
            PhoneOptions.Model(ref: "claude:opus", name: "Opus 5.5", group: "Claude"),
            PhoneOptions.Model(ref: "custom:mine", name: "My Llama", group: "Your models"),
            PhoneOptions.Model(ref: "custom:gpt", name: "GPT-6.1 Sol", group: "OpenAI GPT"),
            PhoneOptions.Model(ref: "router", name: "Model Router", router: true),
        ]
        let sections = ModelMenu.sections(models)
        XCTAssertEqual(sections.map(\.title), ["", "Anthropic Claude", "OpenAI GPT", "Google Gemini", "Moonshot Kimi", "Your models", "On this Mac"])
        XCTAssertEqual(sections[0].models.map(\.ref), ["router"])
        XCTAssertEqual(sections[1].models.map(\.ref), ["claude:opus"])  // "Claude" -> Anthropic Claude
        XCTAssertEqual(sections[4].models.map(\.ref), ["custom:k26"])  // "Moonshot" -> Moonshot Kimi
        XCTAssertTrue(ModelMenu.sections([]).isEmpty)
    }

    func testCurrentModelIsByRefThenName() {
        let models = [PhoneOptions.Model(ref: "router", name: "Model Router", router: true),
                      PhoneOptions.Model(ref: "claude:opus", name: "Claude Opus 5.5")]
        XCTAssertEqual(ModelMenu.current(models, ref: "router", label: "Model Router")?.ref, "router")
        XCTAssertEqual(ModelMenu.current(models, ref: "", label: "Claude Opus 5.5")?.ref, "claude:opus")
        XCTAssertNil(ModelMenu.current(models, ref: "nope", label: "Nope"))
    }

    func testViewSaysModelRouterWhileRouting() throws {
        let view = try decode(PhoneView.self, """
        {"id": 5, "model": "router", "model_label": "Model Router", "routed_label": "Claude Sonnet 5.5", "router": true}
        """)
        XCTAssertTrue(view.router)
        XCTAssertEqual(view.modelLabel, "Model Router")
        XCTAssertEqual(view.routedLabel, "Claude Sonnet 5.5")
        // An older Mac: a raw id for the label is worded; no router field, no routing.
        let older = try decode(PhoneView.self, #"{"id": 6, "model": "custom:k27", "model_label": "kimi-k2.7-code"}"#)
        XCTAssertFalse(older.router)
        XCTAssertEqual(older.modelLabel, "Kimi K2.7 Code")
    }

    func testModeShortWords() {
        XCTAssertEqual(CodeModes.short("auto"), "Bypass")
        XCTAssertEqual(CodeModes.short("edits"), "Accept edits")
        XCTAssertEqual(PhoneOptions.Mode(id: "auto", name: "Bypass permissions").short, "Bypass")
    }

    func testRestingSessionsAreQuietNotWaiting() {
        XCTAssertEqual(GStatus.word(.resting), "Resting")
        XCTAssertEqual(GStatus.word(.idle), "Resting")
        XCTAssertEqual(GStatus.word(.needsYou), "Needs your OK")
        XCTAssertFalse(GStatus.showsIndicator(.resting))
        XCTAssertFalse(GStatus.showsIndicator(.idle))
        XCTAssertTrue(GStatus.showsIndicator(.needsYou))
        XCTAssertTrue(GStatus.showsIndicator(.working))
        XCTAssertEqual(GStatus.restingLine(nil), "Resting")
        let now = Date()
        XCTAssertTrue(GStatus.restingLine(now.addingTimeInterval(-7200), now: now).hasPrefix("Resting · "))
        XCTAssertFalse(GStatus.restingLine(now.addingTimeInterval(-7200), now: now).contains("Waiting"))
    }
}
