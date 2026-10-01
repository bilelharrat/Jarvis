import XCTest
@testable import JarvisCompanion

/// Projects for Jarvis on the iPhone: kept, their files and instructions going with each
/// request, chats filed in them; and the Mac's projects read from its listing.
@MainActor
final class ProjectTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testAProjectIsKeptWithItsFiles() throws {
        let dir = try folder()
        let store = ProjectStore(folder: dir)
        XCTAssertNil(store.create(name: "   "))
        let project = try XCTUnwrap(store.create(name: "  Lisbon trip ", instructions: "Answer in French."))
        XCTAssertEqual(project.name, "Lisbon trip")
        XCTAssertNil(store.addFile(project.id, name: "plan.md", text: "Day 1: Alfama"))
        XCTAssertNotNil(store.addFile(project.id, name: "empty.txt", text: "  "))
        XCTAssertNil(store.addFile(project.id, name: "plan.md", text: "Day 1: Belém"))  // replaced, by name
        let reloaded = ProjectStore(folder: dir)
        let kept = try XCTUnwrap(reloaded.project(project.id))
        XCTAssertEqual(kept.files.map(\.text), ["Day 1: Belém"])
        XCTAssertTrue(kept.note.contains("Lisbon trip") && kept.note.contains("Answer in French.") && kept.note.contains("Day 1: Belém"))
        reloaded.update(project.id, name: "Porto trip")
        XCTAssertEqual(ProjectStore(folder: dir).project(project.id)?.instructions, "Answer in French.")
        reloaded.removeFile(project.id, name: "plan.md")
        XCTAssertFalse(ProjectStore(folder: dir).project(project.id)?.note.contains("Belém") ?? true)
    }

    func testChatsAreFiledInProjects() throws {
        let store = ChatStore(folder: try folder())
        let project = UUID(), chat = UUID(), other = UUID()
        let lines = [SavedChat.Line(role: "user", text: "Hotels?", time: Date())]
        store.keep(id: chat, messages: [], lines: lines, project: project)
        store.keep(id: other, messages: [], lines: lines)
        XCTAssertEqual(store.chats(in: project).map(\.id), [chat])
        store.file(other, in: project)
        XCTAssertEqual(Set(store.chats(in: project).map(\.id)), [chat, other])
        store.unfileAll(from: project)
        XCTAssertTrue(store.chats(in: project).isEmpty)
        XCTAssertNotNil(store.chat(chat))  // the chats stay
    }

    func testTheSystemPromptCarriesTheProject() {
        let prompt = LocalBrain.systemPrompt(macName: nil, hasMac: false, spoken: false, project: "This chat is in the owner's project “Trip”.")
        XCTAssertTrue(prompt.contains("project “Trip”"))
        XCTAssertFalse(LocalBrain.systemPrompt(macName: nil, hasMac: false, spoken: false).contains("project"))
    }

    func testTheMacsListingReads() throws {
        let json: JSONValue = [
            "active": "a1", "current": "s2",
            "items": [["id": "a1", "name": "Launch", "instructions": "Be brief.",
                       "files": [["name": "notes.md", "chars": 1200]],
                       "conversations": [["session_id": "s2", "title": "Pricing"]]]],
        ]
        let listing = MacProject.listing(json)
        XCTAssertEqual(listing.active, "a1")
        XCTAssertEqual(listing.current, "s2")
        XCTAssertEqual(listing.items.first?.files.first?.chars, 1200)
        XCTAssertEqual(listing.items.first?.conversations.first?.title, "Pricing")
    }
}
