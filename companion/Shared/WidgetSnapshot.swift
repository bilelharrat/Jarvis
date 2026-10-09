import Foundation

/// What the widgets and complications show, written by the app (on launch, on every state
/// it gets, on a push, on background refresh) into the App Group container: the widgets
/// never talk to the Mac themselves.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    struct Event: Codable, Equatable, Sendable {
        var title: String
        var begin: Date
    }

    var macName: String
    /// The Mac answered on the last try. (Its moment-to-moment state, thinking or speaking,
    /// isn't a widget's business: it would spend the reload budget on every turn.)
    var online: Bool
    /// When the Mac last answered.
    var updatedAt: Date
    var nextEvent: Event?
    var pendingApprovals: Int
    /// The first approval's question: shown only unlocked (privacy sensitive in the views).
    var approvalQuestion: String?
    var approvalFromCode: Bool
    /// Eden Code sessions worth showing: the ones that need you, then working, then the
    /// latest others (at most four).
    var codeSessions: [CodeSessionSummary]
    var delegationsActive: Int
    var meeting: String?

    static let fileName = "widget-snapshot.json"

    var needsYouCount: Int { codeSessions.filter { $0.status == .needsYou }.count }
    var workingCount: Int { codeSessions.filter { $0.status == .working }.count }

    /// Not heard from the Mac for a while: say so rather than show old news as current.
    func isStale(at now: Date = Date()) -> Bool {
        !online || now.timeIntervalSince(updatedAt) > 45 * 60
    }

    /// The same as what's shown, ignoring when it was fetched: a widget reload is worth it
    /// only when this changes.
    func looksTheSame(as other: WidgetSnapshot?) -> Bool {
        guard var other else { return false }
        other.updatedAt = updatedAt
        return other == self
    }

    static func from(_ remote: RemoteState, macName: String, at now: Date = Date()) -> WidgetSnapshot {
        let sessions = remote.codeSessions
        let ordered = sessions.filter { $0.status == .needsYou }
            + sessions.filter { $0.status == .working }
            + sessions.filter { !$0.status.isLive }
        let first = remote.approvals.first
        return WidgetSnapshot(
            macName: macName,
            online: true,
            updatedAt: now,
            nextEvent: remote.nextEvent.flatMap { event in
                event.date.map { Event(title: event.title, begin: $0) }
            },
            pendingApprovals: remote.pendingApprovals,
            approvalQuestion: first?.question,
            approvalFromCode: first?.source == .code,
            codeSessions: Array(ordered.prefix(4)),
            delegationsActive: remote.delegationsActive,
            meeting: remote.meeting
        )
    }

    /// The Mac couldn't be reached: what was known, marked so.
    func offline() -> WidgetSnapshot {
        var copy = self
        copy.online = false
        return copy
    }

    /// Before any state has come in.
    static func waiting(macName: String) -> WidgetSnapshot {
        WidgetSnapshot(
            macName: macName, online: false, updatedAt: .distantPast,
            nextEvent: nil, pendingApprovals: 0, approvalQuestion: nil, approvalFromCode: false,
            codeSessions: [], delegationsActive: 0, meeting: nil
        )
    }

    /// For the widget gallery.
    static let preview = WidgetSnapshot(
        macName: "Your Mac", online: true, updatedAt: Date(),
        nextEvent: Event(title: "Design review", begin: Date().addingTimeInterval(45 * 60)),
        pendingApprovals: 1, approvalQuestion: "Send the email to Pepper?", approvalFromCode: false,
        codeSessions: [
            CodeSessionSummary(id: 1, title: "Fix the login bug", project: "suit", status: .needsYou),
            CodeSessionSummary(id: 2, title: "Write the docs", project: "arc", status: .working),
        ],
        delegationsActive: 1, meeting: nil
    )
}

/// The snapshot on disk, in the App Group container (the Watch has its own container).
struct SnapshotStore: Sendable {
    let url: URL

    static let shared = SnapshotStore(url: AppGroup.directory.appending(path: WidgetSnapshot.fileName))

    /// Nil when there's none, or it can't be read (never a crash in a widget).
    func read() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decoder.decode(WidgetSnapshot.self, from: data)
    }

    /// Writes it; true when what's shown changed (a reload is worth it).
    @discardableResult
    func write(_ snapshot: WidgetSnapshot) -> Bool {
        let changed = !snapshot.looksTheSame(as: read())
        if let data = try? Self.encoder.encode(snapshot) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        return changed
    }

    func clear() {
        try? FileManager.default.removeItem(at: url)
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }()
}

/// When a widget redraws by itself between the app's reloads: now, when the next event
/// starts (so "Next" moves on), and when what it shows goes stale.
enum SnapshotTimeline {
    static let horizon: TimeInterval = 6 * 60 * 60

    static func dates(for snapshot: WidgetSnapshot?, now: Date) -> [Date] {
        var dates = [now]
        if let begin = snapshot?.nextEvent?.begin, begin > now, begin < now.addingTimeInterval(horizon) {
            dates.append(begin)
        }
        if let snapshot, snapshot.online {
            let stale = snapshot.updatedAt.addingTimeInterval(45 * 60)
            if stale > now, stale < now.addingTimeInterval(horizon) { dates.append(stale) }
        }
        return dates.sorted()
    }
}
