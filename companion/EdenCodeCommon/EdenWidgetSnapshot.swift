import Foundation

// Shared by the Eden Code app (which writes it) and its widgets (which read it).

/// What the Home Screen widget shows: kept in the App Group by the app, read by the widget.
struct EdenWidgetSnapshot: Codable, Equatable, Sendable {
    struct Item: Codable, Equatable, Sendable {
        var id: Int
        var title: String
        var project: String
        var status: String
    }

    var mac: String
    var needsYou: Int
    var working: Int
    var items: [Item]
    var at: Date

    static let placeholder = EdenWidgetSnapshot(mac: "MacBook Air", needsYou: 1, working: 2, items: [
        Item(id: 5, title: "Fix share-sheet crash", project: "askeden / site", status: "working"),
        Item(id: 6, title: "Passkey sign-in", project: "askeden / site", status: "needs_you"),
    ], at: Date())
}

enum WidgetSnapshotStore {
    static let file = "edencode-widget.json"

    static var url: URL { AppGroup.directory.appending(path: file) }

    static func load() -> EdenWidgetSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(EdenWidgetSnapshot.self, from: data)
    }

}
