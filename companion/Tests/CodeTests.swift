import XCTest
@testable import JarvisCompanion

/// Jarvis Code from the iPhone: what a new session can be, what actions answer, questions
/// answered fully, and a session's settings and waiting messages.
final class CodeTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testOptionsSayWhatANewSessionCanBe() throws {
        let options = CodeOptions(try json(#"""
        {"projects":[{"name":"alpha","branch":"main","running":1,"path":"/x/alpha"},{"name":""}],
         "models":[{"ref":"opus","name":"Opus 5.5"}],"modes":[{"id":"plan","name":"Plan"},{"id":"auto","name":"Bypass permissions"}],
         "efforts":["low","high"],"defaults":{"model":"opus","mode":"plan","effort":"high"}}
        """#))
        XCTAssertEqual(options.projects.map(\.name), ["alpha"])
        XCTAssertEqual(options.projects.first?.running, 1)
        XCTAssertEqual(options.models.first?.name, "Opus 5.5")
        XCTAssertEqual(options.defaultMode, "plan")
        XCTAssertTrue(CodeOptions.needsOwner(mode: "auto"))  // Bypass: Face ID first
        XCTAssertFalse(CodeOptions.needsOwner(mode: "edits"))
        XCTAssertEqual(CodeOptions.modeName("ask"), "Manual")
    }

    func testAnActionsAnswerCarriesWhatTheMacSaidAndItsEvents() throws {
        let result = CodeActionResult(try json(#"{"ok":true,"said":"Committed abc1234.","code_git":{"branch":"main"}}"#))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.said, "Committed abc1234.")
        XCTAssertEqual(result["code_git"]?["branch"]?.stringValue, "main")
        XCTAssertFalse(CodeActionResult(try json(#"{"ok":false,"said":"Write a commit message first."}"#)).ok)
    }

    func testAQuestionCardCanBeAnsweredWithSeveralOrInWords() throws {
        let card = try JSONDecoder().decode(Approval.self, from: Data(#"""
        {"id":"a1","question":"Which database?","choices":[{"id":"opt0","label":"Postgres"},{"id":"opt1","label":"SQLite"},{"id":"skip","label":"Skip"}],
         "task_id":5,"ask_kind":"question","multi":true,"options":[{"label":"Postgres","description":"Relational"},{"label":"SQLite"}],
         "free_choices":["pick","other"]}
        """#.utf8))
        XCTAssertTrue(card.isQuestion && card.multi)
        XCTAssertEqual(card.options.map(\.label), ["Postgres", "SQLite"])
        XCTAssertEqual(card.freeChoices, ["pick", "other"])
        let picks = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(QuestionCard.picks([0, 1], own: "").utf8)) as? [String: Any])
        XCTAssertEqual(picks["picked"] as? [Int], [0, 1])
        let plain = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"b","question":"Run tests?","choices":[{"id":"allow","label":"Yes"}]}"#.utf8))
        XCTAssertFalse(plain.isQuestion)  // an older Mac's card, or a permission card
    }

    func testASessionSaysItsSettingsAndWhatsWaiting() throws {
        let detail = try JSONDecoder().decode(CodeSessionDetail.self, from: Data(#"""
        {"id":5,"title":"Login fix","status":"working","entries":[{"i":1,"role":"user","text":"fix login","uuid":"u-1"}],
         "todos":[],"mode":"edits","model":"sonnet","model_label":"Sonnet 5.5","effort":"high","project":"alpha",
         "queued":[{"item":3,"text":"also add a test"}]}
        """#.utf8))
        XCTAssertEqual(detail.mode, "edits")
        XCTAssertEqual(detail.modelLabel, "Sonnet 5.5")
        XCTAssertEqual(detail.queued.map(\.item), [3])
        XCTAssertEqual(detail.entries.first?.uuid, "u-1")  // Rewind goes back to it
    }
}
