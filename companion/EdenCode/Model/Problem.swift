import Foundation
import Network

/// What went wrong talking to the Mac, in Eden Code's words, and the one thing to do about it:
/// offline (this iPhone has no network), the Mac can't be reached (asleep, Eden Code closed,
/// another network), the Mac forgot this iPhone (unpaired or its pairing expired), the phone
/// page switched off on the Mac, or anything else. The store's banner shows it with its button.
///
/// The companion's JarvisError words say "Eden Secretary" (they're shared with the Eden app,
/// which this app must not change), so the cases this app meets are worded here.
struct EdenCodeProblem: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case offline, unreachable, unpaired, switchedOff, notYourMac, other }
    enum Action: Equatable, Sendable { case retry, pairAgain }

    var kind: Kind
    var title: String
    var message: String
    var action: Action

    /// One line, for the places that show only text (and VoiceOver).
    var text: String { "\(title). \(message)" }
    var actionLabel: String { action == .pairAgain ? "Pair again" : "Try again" }

    /// nil for what isn't a problem (a task cancelled as the screen changed).
    init?(_ error: Error, online: Bool) {
        if error is CancellationError { return nil }
        if let url = error as? URLError, url.code == .cancelled { return nil }
        if !online || (error as? URLError)?.code == .notConnectedToInternet || (error as? URLError)?.code == .dataNotAllowed {
            self.init(.offline, "You’re offline", "Connect to Wi‑Fi or mobile data. Eden Code tries again by itself.", .retry)
            return
        }
        switch error as? JarvisError {
        case .unreachable, .timedOut, .connectionLost:
            self.init(.unreachable, "Can’t reach your Mac",
                      "It may be asleep, or Eden Code isn’t open on it. Wake your Mac and keep Eden Code running. Away from home, sign in to your Eden account in the Eden app, or use Tailscale.", .retry)
        case .unpaired, .notPinned:
            self.init(.unpaired, "Your Mac doesn’t know this iPhone anymore",
                      "It was removed on the Mac or its pairing expired. On your Mac, open Eden Code › On your phone and pair again.", .pairAgain)
        case .certificateMismatch, .fingerprintRefused:
            self.init(.notYourMac, "This isn’t your Mac",
                      "Something else answered at your Mac’s address, so nothing was sent. Check you’re on your own network, then try again.", .retry)
        case .rejected(let message) where message.contains("Open on my phone") || message.contains("Hand off to phone"):
            self.init(.switchedOff, "Turned off on your Mac",
                      "Turn on Eden Code on your phone on the Mac: Eden Code › More › Open on my phone.", .retry)
        case .some(let jarvis):
            self.init(.other, Self.ours(jarvis.title), Self.ours(jarvis.message), .retry)
        case .none:
            self.init(.other, "Something went wrong", error.localizedDescription, .retry)
        }
    }

    init(_ kind: Kind, _ title: String, _ message: String, _ action: Action) {
        self.kind = kind
        self.title = title
        self.message = message
        self.action = action
    }

    /// The shared words, with this app's name.
    static func ours(_ text: String) -> String {
        text.replacingOccurrences(of: "Eden Secretary", with: "Eden Code")
    }
}

/// Whether this iPhone has any network at all (to say "offline" rather than blame the Mac).
final class NetworkWatch: @unchecked Sendable {
    static let shared = NetworkWatch()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var satisfied = true

    var online: Bool { lock.withLock { self.satisfied } }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            lock.withLock { self.satisfied = path.status == .satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "edencode.network"))
    }
}

extension EdenCodeProblem {
    /// One line for an error, in this app's words (nil when it isn't a problem).
    static func describe(_ error: Error) -> String? {
        EdenCodeProblem(error, online: NetworkWatch.shared.online)?.text
    }
}
