import XCTest
@testable import JarvisCompanion

/// Chats with Jarvis on the iPhone: kept, found, renamed, pinned, picked up, temporary; and
/// replies laid out from Markdown; and documents read for the brain.
@MainActor
final class ChatTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func line(_ role: String, _ text: String) -> SavedChat.Line {
        SavedChat.Line(role: role, text: text, time: Date())
    }

    func testAChatIsKeptTitledFoundRenamedPinnedAndDeleted() throws {
        let dir = try folder()
        let store = ChatStore(folder: dir)
        let first = UUID(), second = UUID()
        store.keep(id: first, messages: [], lines: [line("user", "What's the capital of Portugal and why is it there?"), line("jarvis", "Lisbon.")])
        store.keep(id: second, messages: [], lines: [line("user", "Plan a run"), line("jarvis", "Try 5k easy.")])
        XCTAssertEqual(store.chats.map(\.id), [second, first])  // most recent first
        XCTAssertEqual(store.chat(first)?.title, "What's the capital of Portugal and why is")
        XCTAssertEqual(store.search("lisbon").map(\.id), [first])  // what was said, not only titles
        store.togglePin(first)
        XCTAssertEqual(store.chats.first?.id, first)  // pinned first
        store.rename(first, to: "  Portugal  ")
        store.keep(id: first, messages: [], lines: [line("user", "Something else"), line("jarvis", "Sure.")])
        XCTAssertEqual(store.chat(first)?.title, "Portugal")  // a name the owner gave stays
        let reloaded = ChatStore(folder: dir)
        XCTAssertEqual(reloaded.chats.map(\.id), [first, second])
        reloaded.delete(first)
        XCTAssertEqual(ChatStore(folder: dir).chats.map(\.id), [second])
        store.keep(id: UUID(), messages: [], lines: [line("jarvis", "Hello.")])  // nothing asked: not kept
        XCTAssertEqual(ChatStore(folder: dir).chats.count, 1)
    }

    func testKeptChatsLeaveThePicturesAndDocumentsBytesBehind() {
        let messages: [JSONValue] = [["role": "user", "content": [
            ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": "AAAA"]],
            ["type": "document", "title": "lease.pdf", "source": ["type": "base64", "media_type": "application/pdf", "data": "BBBB"]],
            ["type": "text", "text": "Summarize"],
        ]]]
        let slim = SavedChat.slim(messages)[0]["content"]?.arrayValue ?? []
        XCTAssertEqual(slim.map { $0["type"]?.stringValue }, ["text", "text", "text"])
        XCTAssertEqual(slim[1]["text"]?.stringValue, "[A document was shared here: lease.pdf.]")
        XCTAssertFalse(String(data: try! JSONEncoder().encode(slim), encoding: .utf8)!.contains("BBBB"))
    }

    func testAPickedUpChatCanBeEditedAndATemporaryOneIsntKept() {
        let brain = LocalBrain()
        let chat = SavedChat(id: UUID(), title: "Weather", created: Date(), updated: Date(),
                             messages: [["role": "user", "content": [["type": "text", "text": "Weather?"]]],
                                        ["role": "assistant", "content": [["type": "text", "text": "Sunny."]]]],
                             lines: [line("user", "Weather?"), line("jarvis", "Sunny.")])
        brain.open(chat)
        XCTAssertEqual(brain.chatID, chat.id)
        XCTAssertEqual(brain.turns.map(\.text), ["Weather?", "Sunny."])
        XCTAssertEqual(brain.takeBackLast(), "Weather?")  // back into the composer to edit
        XCTAssertTrue(brain.turns.isEmpty)
        brain.newChat(temporary: true)
        XCTAssertTrue(brain.temporary)
        XCTAssertNotEqual(brain.chatID, chat.id)
        XCTAssertTrue(brain.tools.temporary)  // nothing remembered from it either
        brain.newChat()
        XCTAssertFalse(brain.temporary)
    }

    func testRepliesAreLaidOutFromMarkdown() {
        let blocks = MarkdownBlocks.parse("""
        ## Steps
        Here's **how**:

        1. Open it
        2. Close it

        - one
        - two

        ```swift
        let x = 1
        ```

        | A | B |
        |---|---|
        | 1 | 2 |

        > Quoted
        """)
        XCTAssertEqual(blocks, [
            .heading(2, "Steps"),
            .paragraph("Here's **how**:"),
            .list(["Open it", "Close it"], ordered: true),
            .list(["one", "two"], ordered: false),
            .code("swift", "let x = 1"),
            .table(["A", "B"], [["1", "2"]]),
            .quote("Quoted"),
        ])
        XCTAssertEqual(MarkdownBlocks.parse("Just a line."), [.paragraph("Just a line.")])
        XCTAssertEqual(MarkdownBlocks.parse("```\nunclosed"), [.code("", "unclosed")])  // still being written
    }

    func testDocumentsAreReadForTheBrain() throws {
        let dir = try folder()
        let text = dir.appendingPathComponent("notes.md")
        try Data("# Notes\nBuy milk".utf8).write(to: text)
        let pdf = dir.appendingPathComponent("lease.pdf")
        try Data("%PDF-1.4 fake".utf8).write(to: pdf)
        let binary = dir.appendingPathComponent("blob.bin")
        try Data([0, 1, 2, 0]).write(to: binary)

        guard case .success(let notes) = PickedDocument.read(text) else { return XCTFail("text") }
        XCTAssertEqual(notes.block?["type"]?.stringValue, "text")
        XCTAssertTrue(notes.block?["text"]?.stringValue?.contains("Buy milk") == true)
        guard case .success(let lease) = PickedDocument.read(pdf) else { return XCTFail("pdf") }
        XCTAssertTrue(lease.isPDF)
        XCTAssertEqual(lease.block?["source"]?["media_type"]?.stringValue, "application/pdf")
        guard case .failure = PickedDocument.read(binary) else { return XCTFail("binary") }

        // Gemini takes the PDF as inline data, the text as text.
        let contents = GeminiClient.contents([["role": "user", "content": [lease.block!, notes.block!]]])
        let parts = contents[0]["parts"]?.arrayValue ?? []
        XCTAssertEqual(parts[0]["inlineData"]?["mimeType"]?.stringValue, "application/pdf")
        XCTAssertTrue(parts[1]["text"]?.stringValue?.contains("Buy milk") == true)
    }

    func testStudyModeTutorsAndIsKeptWithTheChat() throws {
        XCTAssertTrue(LocalBrain.systemPrompt(macName: nil, hasMac: false, spoken: false, study: true).contains("Study mode is on"))
        XCTAssertFalse(LocalBrain.systemPrompt(macName: nil, hasMac: false, spoken: false).contains("Study mode is on"))
        let dir = try folder()
        let store = ChatStore(folder: dir)
        let id = UUID()
        store.keep(id: id, messages: [], lines: [line("user", "Teach me derivatives")], study: true)
        XCTAssertEqual(ChatStore(folder: dir).chat(id)?.study, true)
        // A chat kept before study mode existed loads with it off.
        let old = #"[{"id":"\#(UUID().uuidString)","title":"Old","created":0,"updated":0,"pinned":false,"renamed":false,"messages":[],"lines":[]}]"#
        try Data(old.utf8).write(to: dir.appendingPathComponent("phone-chats.json"))
        XCTAssertNil(ChatStore(folder: dir).chats.first?.study)
    }
}
