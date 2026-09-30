import Foundation

/// A place in the iPhone app, opened from a notification, a widget, a Live Activity or
/// Siri as a `jarvis-companion://…` link.
enum Destination: Hashable, Sendable {
    case home
    case code
    case codeSession(Int)
    case conversations
    case routines
    case digest
    case spending
    case showJarvis
    case outbox

    static let scheme = "jarvis-companion"

    var url: URL {
        URL(string: "\(Self.scheme)://\(path)") ?? URL(string: "\(Self.scheme)://home")!
    }

    private var path: String {
        switch self {
        case .home: "home"
        case .code: "code"
        case .codeSession(let id): "code/\(id)"
        case .conversations: "conversations"
        case .routines: "routines"
        case .digest: "digest"
        case .spending: "spending"
        case .showJarvis: "show-jarvis"
        case .outbox: "outbox"
        }
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
        switch parts.first?.lowercased() {
        case "home", nil: self = .home
        case "code":
            if parts.count > 1 {
                guard let id = Int(parts[1]) else { return nil }
                self = .codeSession(id)
            } else {
                self = .code
            }
        case "conversations": self = .conversations
        case "routines": self = .routines
        case "digest": self = .digest
        case "spending": self = .spending
        case "show-jarvis": self = .showJarvis
        case "outbox": self = .outbox
        default: return nil
        }
    }

    /// Where a push leads when it's tapped.
    init(push: JarvisPush) {
        switch push.kind {
        case .codeApproval, .codeDone, .codeNeedsYou:
            self = push.taskID.map { .codeSession($0) } ?? .code
        case .delegation: self = .conversations
        default: self = .home
        }
    }
}
