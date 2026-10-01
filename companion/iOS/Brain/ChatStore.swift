import Foundation

/// The conversations Jarvis on the iPhone has had, kept on the iPhone (the App Group
/// container) so they can be found, picked up again, renamed, pinned or deleted, as in the
/// Claude, ChatGPT and Gemini apps. A temporary chat is never kept.
struct SavedChat: Codable, Identifiable, Equatable {
    struct Line: Codable, Equatable {
        var role: String  // user, jarvis, problem
        var text: String
        var time: Date
        var pictures: [Data] = []
        var files: [String] = []
    }

    var id: UUID
    var title: String
    var created: Date
    var updated: Date
    var pinned = false
    /// Named by the owner: the title isn't replaced from the first question any more.
    var renamed = false
    /// The API's view (Claude's blocks; pictures and documents left out to keep it small).
    var messages: [JSONValue]
    var lines: [Line]

    /// The first words of the first question, as a title.
    static func title(from question: String) -> String {
        let words = question.trimmed.split(whereSeparator: \.isWhitespace).prefix(8).joined(separator: " ")
        guard !words.isEmpty else { return "Pictures" }
        return words.count > 48 ? String(words.prefix(47)) + "…" : words
    }

    /// Whether the chat mentions this (its title or anything said).
    func matches(_ query: String) -> Bool {
        let query = query.trimmed
        guard !query.isEmpty else { return true }
        return title.localizedCaseInsensitiveContains(query) || lines.contains { $0.text.localizedCaseInsensitiveContains(query) }
    }

    /// The messages without the big parts (a picture's or a document's bytes): a picked-up
    /// chat remembers that they were there, not what they were.
    static func slim(_ messages: [JSONValue]) -> [JSONValue] {
        messages.map { message in
            guard case .object(var object) = message, let blocks = object["content"]?.arrayValue else { return message }
            object["content"] = .array(blocks.map { block in
                switch block["type"]?.stringValue {
                case "image": return ["type": "text", "text": "[A picture was shared here.]"]
                case "document": return ["type": "text", "text": .string("[A document was shared here: \(block["title"]?.stringValue ?? "a file").]")]
                case "_gemini":
                    // Gemini's own record of its turn: its inline pictures go too.
                    guard case .object(var raw) = block, let parts = raw["parts"]?.arrayValue else { return block }
                    raw["parts"] = .array(parts.filter { $0["inlineData"] == nil })
                    return .object(raw)
                default: return block
                }
            })
            return .object(object)
        }
    }
}

@MainActor
@Observable
final class ChatStore {
    static let shared = ChatStore()

    /// Pinned first, then the most recent.
    private(set) var chats: [SavedChat] = []
    @ObservationIgnored private let url: URL

    init(folder: URL = AppGroup.directory) {
        url = folder.appendingPathComponent("phone-chats.json")
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([SavedChat].self, from: data) {
            chats = saved
            sort()
        }
    }

    func chat(_ id: UUID) -> SavedChat? { chats.first { $0.id == id } }

    func search(_ query: String) -> [SavedChat] { chats.filter { $0.matches(query) } }

    /// Keeps the chat as it is now (a new one is added).
    func keep(id: UUID, messages: [JSONValue], lines: [SavedChat.Line]) {
        guard lines.contains(where: { $0.role == "user" }) else { return }
        let firstQuestion = lines.first { $0.role == "user" }?.text ?? ""
        if let index = chats.firstIndex(where: { $0.id == id }) {
            chats[index].messages = SavedChat.slim(messages)
            chats[index].lines = lines
            chats[index].updated = Date()
            if !chats[index].renamed { chats[index].title = SavedChat.title(from: firstQuestion) }
        } else {
            chats.append(SavedChat(id: id, title: SavedChat.title(from: firstQuestion), created: Date(), updated: Date(),
                                   messages: SavedChat.slim(messages), lines: lines))
        }
        if chats.count > 500, let oldest = chats.filter({ !$0.pinned }).min(by: { $0.updated < $1.updated }) {
            chats.removeAll { $0.id == oldest.id }
        }
        sort()
        save()
    }

    func rename(_ id: UUID, to title: String) {
        guard let index = chats.firstIndex(where: { $0.id == id }), !title.trimmed.isEmpty else { return }
        chats[index].title = String(title.trimmed.prefix(80))
        chats[index].renamed = true
        save()
    }

    func togglePin(_ id: UUID) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        chats[index].pinned.toggle()
        sort()
        save()
    }

    func delete(_ id: UUID) {
        chats.removeAll { $0.id == id }
        save()
    }

    func deleteAll() {
        chats = []
        save()
    }

    private func sort() {
        chats.sort { $0.pinned != $1.pinned ? $0.pinned : $0.updated > $1.updated }
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(chats).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
