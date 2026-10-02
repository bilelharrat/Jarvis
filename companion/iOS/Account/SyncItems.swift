import Foundation

/// The items sync carries, as their plaintext JSON (docs/accounts.md › Sync › Items), and how
/// they merge. Pure: the engine seals, sends and applies them.
enum SyncItems {
    static let keycheck = "keycheck"
    static let memory = "memory"
    static let settings = "settings"
    static let chatPrefix = "chat:"

    /// A tombstone is kept this long, so every device hears about the delete.
    static let tombstoneLife: TimeInterval = 90 * 24 * 3600

    static func chatKey(_ id: UUID) -> String { chatPrefix + id.uuidString.lowercased() }

    static func chatID(fromKey key: String) -> UUID? {
        guard key.hasPrefix(chatPrefix) else { return nil }
        return UUID(uuidString: String(key.dropFirst(chatPrefix.count)))
    }

    /// Keys as the server takes them: `[A-Za-z0-9._:-]{1,128}`.
    static func isValidKey(_ key: String) -> Bool {
        (1...128).contains(key.count) && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._:-".contains($0)) }
    }

    static func encode(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    // MARK: - keycheck

    static let keycheckValue: JSONValue = ["v": 1, "check": "jarvis-sync-v1"]

    static func isKeycheck(_ plaintext: Data) -> Bool {
        (try? JSONDecoder().decode(JSONValue.self, from: plaintext))?["check"]?.stringValue == "jarvis-sync-v1"
    }

    // MARK: - memory

    struct WireFact: Codable, Equatable, Sendable {
        var id: String
        var text: String
        var category: String
        /// ms since 1970.
        var updated: Int64
        var deleted: Bool

        init(id: String, text: String, category: String, updated: Int64, deleted: Bool = false) {
            self.id = id
            self.text = text
            self.category = category
            self.updated = updated
            self.deleted = deleted
        }

        private enum Key: String, CodingKey { case id, text, category, updated, deleted }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let id = c.text(.id)?.lowercased(), !id.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: [Key.id], debugDescription: "No fact id"))
            }
            self.id = id
            text = c.text(.text) ?? ""
            category = c.text(.category)?.lowercased() ?? "other"
            updated = Int64(c.number(.updated) ?? 0)
            deleted = c.flag(.deleted) ?? false
        }
    }

    struct Memory: Codable, Equatable, Sendable {
        var v = 1
        var facts: [WireFact]

        init(facts: [WireFact]) {
            self.facts = facts
        }

        private enum Key: String, CodingKey { case v, facts }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            v = c.integer(.v) ?? 1
            facts = c.list(WireFact.self, .facts)
        }
    }

    /// The iPhone's kinds as the Mac's categories, and back. The Mac's own categories the
    /// iPhone has no kind for (work, health, places) are plain facts here, and keep their
    /// category when they go back.
    static func category(for kind: LocalMemory.Fact.Kind) -> String {
        switch kind {
        case .person: "people"
        case .preference: "preferences"
        case .goal: "goals"
        case .correction: "corrections"
        case .fact: "other"
        }
    }

    static func kind(for category: String) -> LocalMemory.Fact.Kind {
        switch category {
        case "people": .person
        case "preferences": .preference
        case "goals": .goal
        case "corrections": .correction
        default: .fact
        }
    }

    /// Union by id; for one id the later `updated` wins (on a tie, a delete). Tombstones
    /// older than 90 days are dropped.
    static func merge(_ mine: [WireFact], _ theirs: [WireFact], now: Date = Date()) -> [WireFact] {
        var byID: [String: WireFact] = [:]
        var order: [String] = []
        for fact in mine + theirs {
            if let known = byID[fact.id] {
                if fact.updated > known.updated || (fact.updated == known.updated && fact.deleted && !known.deleted) {
                    byID[fact.id] = fact
                }
            } else {
                byID[fact.id] = fact
                order.append(fact.id)
            }
        }
        let oldest = Int64((now.timeIntervalSince1970 - tombstoneLife) * 1000)
        return order.compactMap { byID[$0] }.filter { !$0.deleted || $0.updated >= oldest }
    }

    // MARK: - settings

    /// `{"v":1,"updated":ms, "owner_name"?, "address_as"?, "language"?, …}`: fields this
    /// iPhone doesn't know are kept as they came.
    struct Settings: Equatable, Sendable {
        var fields: [String: JSONValue]

        init(fields: [String: JSONValue] = [:]) {
            self.fields = fields
        }

        init?(json: Data) {
            guard case .object(let object)? = try? JSONDecoder().decode(JSONValue.self, from: json) else { return nil }
            fields = object
        }

        var updated: Int64 { Int64(fields["updated"]?.doubleValue ?? 0) }

        var addressAs: String? {
            get { fields["address_as"]?.stringValue }
            set { fields["address_as"] = newValue.map { .string($0) } }
        }

        func encoded() throws -> Data {
            var object = fields
            object["v"] = 1
            return try JSONValue.object(object).encoded()
        }
    }

    // MARK: - chat:<uuid>

    struct Chat: Codable, Equatable, Sendable {
        struct Message: Codable, Equatable, Sendable {
            /// "user" or "assistant".
            var role: String
            var text: String
            /// ms since 1970.
            var at: Int64
        }

        var v = 1
        var id: String
        var title: String
        var updated: Int64
        var messages: [Message]
        var project: String?

        init(id: String, title: String, updated: Int64, messages: [Message], project: String? = nil) {
            self.id = id
            self.title = title
            self.updated = updated
            self.messages = messages
            self.project = project
        }
    }

    static func chat(from saved: SavedChat) -> Chat {
        Chat(
            id: saved.id.uuidString.lowercased(), title: saved.title, updated: ms(saved.updated),
            messages: saved.lines.compactMap { line in
                switch line.role {
                case "user": Chat.Message(role: "user", text: line.text, at: ms(line.time))
                case "jarvis": Chat.Message(role: "assistant", text: line.text, at: ms(line.time))
                default: nil  // problems stay on the iPhone that had them
                }
            },
            project: saved.project?.uuidString.lowercased()
        )
    }

    /// A synced chat as the iPhone keeps it; what only this iPhone knows (pinned, renamed,
    /// study mode, pictures) is kept from `existing`.
    static func savedChat(from chat: Chat, existing: SavedChat?) -> SavedChat? {
        guard let id = UUID(uuidString: chat.id) else { return nil }
        let lines = chat.messages.map { message in
            SavedChat.Line(role: message.role == "user" ? "user" : "jarvis", text: message.text, time: date(message.at))
        }
        let messages: [JSONValue] = chat.messages.map { message in
            ["role": .string(message.role == "user" ? "user" : "assistant"),
             "content": [["type": "text", "text": .string(message.text.isEmpty ? "…" : message.text)]]]
        }
        var saved = existing ?? SavedChat(id: id, title: chat.title, created: lines.first?.time ?? date(chat.updated),
                                          updated: date(chat.updated), messages: [], lines: [])
        saved.title = chat.title
        saved.updated = date(chat.updated)
        saved.project = chat.project.flatMap(UUID.init(uuidString:))
        saved.messages = messages
        // Pictures and files stay with the line they belong to, when it's still there.
        saved.lines = lines.map { line in
            var line = line
            if let old = existing?.lines.first(where: { $0.text == line.text && $0.role == line.role }) {
                line.pictures = old.pictures
                line.files = old.files
            }
            return line
        }
        return saved
    }

    static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
    static func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
}
