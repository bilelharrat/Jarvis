import ActivityKit
import Foundation

/// A Live Activity for something the Mac is doing for you: a Jarvis Code session working or
/// waiting on you, a conversation held for you (a delegation), a call, a video summary.
/// The Mac updates it by push (apns-push-type: liveactivity) with the content state below,
/// and ends it with `event: "end"`.
struct JarvisActivityAttributes: ActivityAttributes {
    /// The companion contract's content state, exactly: `{title, status, detail, progress?,
    /// needsYou, updatedAt}` (updatedAt in epoch seconds). Read leniently: a missing field
    /// falls back rather than failing the update.
    struct ContentState: Codable, Hashable {
        var title: String
        var status: String
        var detail: String
        /// 0...1 when known; the Mac leaves it out otherwise.
        var progress: Double?
        var needsYou: Bool
        /// Epoch seconds.
        var updatedAt: Double

        init(title: String, status: String, detail: String = "", progress: Double? = nil, needsYou: Bool = false, updatedAt: Double) {
            self.title = title
            self.status = status
            self.detail = detail
            self.progress = progress.map { min(1, max(0, $0)) }
            self.needsYou = needsYou
            self.updatedAt = updatedAt
        }

        private enum Key: String, CodingKey { case title, status, detail, progress, needsYou, updatedAt }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            self.init(
                title: c.text(.title) ?? "Jarvis",
                status: c.text(.status) ?? "",
                detail: c.text(.detail) ?? "",
                progress: c.number(.progress),
                needsYou: c.flag(.needsYou) ?? false,
                updatedAt: c.number(.updatedAt) ?? Date().timeIntervalSince1970
            )
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Key.self)
            try c.encode(title, forKey: .title)
            try c.encode(status, forKey: .status)
            try c.encode(detail, forKey: .detail)
            try c.encodeIfPresent(progress, forKey: .progress)
            try c.encode(needsYou, forKey: .needsYou)
            try c.encode(updatedAt, forKey: .updatedAt)
        }

        var updated: Date { Date(timeIntervalSince1970: updatedAt) }

        /// The same as shown, whenever it was made.
        func looksTheSame(as other: ContentState) -> Bool {
            var other = other
            other.updatedAt = updatedAt
            return other == self
        }
    }

    enum Kind: String, Codable, Hashable, CaseIterable {
        case code, delegation, call, video

        var label: String {
            switch self {
            case .code: "Jarvis Code"
            case .delegation: "Conversation"
            case .call: "Call"
            case .video: "Video summary"
            }
        }

        var symbol: String {
            switch self {
            case .code: "chevron.left.forwardslash.chevron.right"
            case .delegation: "bubble.left.and.bubble.right.fill"
            case .call: "phone.fill"
            case .video: "film.stack"
            }
        }
    }

    var kind: Kind
    var itemID: String

    /// "<kind>:<id>", how the Mac names it (POST /api/live/register).
    var key: String { "\(kind.rawValue):\(itemID)" }

    /// Where tapping it leads.
    var destination: Destination {
        switch kind {
        case .code: Int(itemID).map { .codeSession($0) } ?? .code
        case .delegation: .conversations
        case .call, .video: .home
        }
    }
}

/// What should be showing, worked out from the Mac's state: pure, so it can be tested.
enum LiveActivityPlan {
    typealias Kind = JarvisActivityAttributes.Kind
    typealias Content = JarvisActivityAttributes.ContentState

    struct Item: Equatable {
        var kind: Kind
        var itemID: String
        var content: Content

        var key: String { "\(kind.rawValue):\(itemID)" }
    }

    struct Changes: Equatable {
        var start: [Item] = []
        var update: [Item] = []
        /// Keys to end, with what to show last (nil: gone at once).
        var end: [String: Content?] = [:]
    }

    /// At most this many at once (the system caps each app, and more would be noise).
    static let limit = 3

    /// Jarvis Code sessions working or waiting on you; conversations still going (when the
    /// list was fetched).
    static func wanted(sessions: [CodeSessionSummary], delegations: [DelegationItem]?, now: Date) -> [Item] {
        let stamp = now.timeIntervalSince1970
        var items = sessions.filter(\.status.isLive).map { session in
            Item(kind: .code, itemID: String(session.id), content: Content(
                title: session.title,
                status: session.status.label,
                detail: session.project,  // "Needs you" is its status already
                needsYou: session.status == .needsYou,
                updatedAt: stamp
            ))
        }
        for delegation in delegations ?? [] where delegation.isOpen {
            items.append(Item(kind: .delegation, itemID: delegation.id, content: Content(
                title: delegation.with,
                status: delegation.statusLabel,
                detail: delegation.goal,
                needsYou: delegation.needsOwner,
                updatedAt: stamp
            )))
        }
        // What needs you first, so it gets a place when there are too many.
        return items.filter(\.content.needsYou) + items.filter { !$0.content.needsYou }
    }

    /// The last word for a session that finished (shown for a while), when the Mac still lists it.
    static func final(for key: String, sessions: [CodeSessionSummary], now: Date) -> Content? {
        guard key.hasPrefix("code:"), let id = Int(key.dropFirst(5)),
              let session = sessions.first(where: { $0.id == id }), !session.status.isLive else { return nil }
        return Content(title: session.title, status: session.status.label, detail: session.project, updatedAt: now.timeIntervalSince1970)
    }

    /// From what's showing (by key) to what should: which to start, update and end. Only the
    /// kinds the state speaks for are ended here (calls and video summaries end by push).
    static func changes(wanted: [Item], existing: [String: Content], managing kinds: Set<Kind>,
                        sessions: [CodeSessionSummary] = [], now: Date = Date(), canStart: Bool = true) -> Changes {
        var changes = Changes()
        let wantedKeys = Set(wanted.map(\.key))
        for (key, _) in existing {
            guard let kind = Kind(rawValue: String(key.prefix { $0 != ":" })), kinds.contains(kind), !wantedKeys.contains(key) else { continue }
            changes.end[key] = final(for: key, sessions: sessions, now: now)
        }
        var showing = existing.count - changes.end.count
        for item in wanted {
            if let current = existing[item.key] {
                if !item.content.looksTheSame(as: current) { changes.update.append(item) }
            } else if canStart, showing < limit {
                changes.start.append(item)
                showing += 1
            }
        }
        return changes
    }

    /// A call or video-summary push: start one, or, for a call already showing, its outcome.
    static func fromPush(_ push: JarvisPush, existing: Set<String>, now: Date = Date()) -> (item: Item, ends: Bool)? {
        let kind: Kind
        switch push.kind {
        case .call: kind = .call
        case .video: kind = .video
        default: return nil
        }
        guard !push.id.isEmpty else { return nil }
        let key = "\(kind.rawValue):\(push.id)"
        let stamp = now.timeIntervalSince1970
        if existing.contains(key) {
            // The Mac doesn't follow a call as it goes: the next push about it is how it went.
            let status = kind == .call ? "Call ended" : "Ready"
            return (Item(kind: kind, itemID: push.id, content: Content(title: push.title.isEmpty ? kind.label : push.title, status: status, detail: push.body, updatedAt: stamp)), true)
        }
        let status = kind == .call ? "On the call" : "Transcribing"
        return (Item(kind: kind, itemID: push.id, content: Content(title: push.title.isEmpty ? kind.label : push.title, status: status, detail: push.body, updatedAt: stamp)), false)
    }
}
