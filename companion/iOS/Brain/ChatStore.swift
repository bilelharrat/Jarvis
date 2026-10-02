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
    /// Study mode was on (missing in chats kept before it: off).
    var study: Bool?
    /// The phone project it's in (ProjectStore), if any.
    var project: UUID?
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

    /// Posted when the chats change here (not when sync brings them).
    static let changed = Notification.Name("ChatStore.changed")

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
    func keep(id: UUID, messages: [JSONValue], lines: [SavedChat.Line], study: Bool = false, project: UUID? = nil) {
        guard lines.contains(where: { $0.role == "user" }) else { return }
        let firstQuestion = lines.first { $0.role == "user" }?.text ?? ""
        if let index = chats.firstIndex(where: { $0.id == id }) {
            chats[index].messages = SavedChat.slim(messages)
            chats[index].lines = lines
            chats[index].updated = Date()
            chats[index].study = study
            chats[index].project = project
            if !chats[index].renamed { chats[index].title = SavedChat.title(from: firstQuestion) }
        } else {
            chats.append(SavedChat(id: id, title: SavedChat.title(from: firstQuestion), created: Date(), updated: Date(),
                                   study: study, project: project, messages: SavedChat.slim(messages), lines: lines))
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

    /// The chats in a project (pinned first, then the most recent).
    func chats(in project: UUID) -> [SavedChat] { chats.filter { $0.project == project } }

    /// Moves a chat into a project, or out of any (nil).
    func file(_ id: UUID, in project: UUID?) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        chats[index].project = project
        save()
    }

    /// A deleted project's chats stay, in no project.
    func unfileAll(from project: UUID) {
        for index in chats.indices where chats[index].project == project { chats[index].project = nil }
        save()
    }

    func deleteAll() {
        chats = []
        save()
    }

    // MARK: - Sync

    /// A chat as another of the owner's iPhones last kept it.
    func applySynced(_ chat: SavedChat) {
        if let index = chats.firstIndex(where: { $0.id == chat.id }) {
            chats[index] = chat
        } else {
            chats.append(chat)
        }
        sort()
        write()
    }

    /// A chat deleted on another of the owner's iPhones.
    func removeSynced(_ id: UUID) {
        guard chats.contains(where: { $0.id == id }) else { return }
        chats.removeAll { $0.id == id }
        write()
    }

    private func sort() {
        chats.sort { $0.pinned != $1.pinned ? $0.pinned : $0.updated > $1.updated }
    }

    private func save() {
        write()
        NotificationCenter.default.post(name: Self.changed, object: self)
    }

    private func write() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(chats).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
