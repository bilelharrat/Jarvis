import Foundation

/// How a request reaches the paired Mac: straight to its address, or, on the iPhone signed in
/// to a Jarvis account, through the encrypted relay when that address can't be reached.
/// JarvisAPI asks here before every request, so no caller has to know. Without a router (the
/// Watch, the widgets, the share extension) every request goes straight, as it always has.
///
/// Through the relay the base URL is the iPhone's own loopback tunnel
/// (`https://127.0.0.1:<port>`), and the request still carries the Mac's pinned fingerprint:
/// TLS runs end to end, and the pin is checked on the certificate alone, never the host.
enum MacRoute {
    protocol Router: AnyObject, Sendable {
        /// Where a request meant for `direct` goes right now: `direct` itself, or the relay.
        func base(for direct: URL) async -> URL
        /// `direct` just couldn't be reached: the relay's address to try once more through,
        /// or nil when there's no relay to try.
        func directFailed(_ direct: URL) async -> URL?
        /// A request through the relay at `base` broke before the Mac answered: true when
        /// the relay couldn't reach the Mac at all, so nothing was delivered.
        func relayFailed(_ base: URL) async -> Bool
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed: (any Router)?

    /// Set once by the iPhone app at launch.
    static var router: (any Router)? {
        get { lock.withLock { installed } }
        set { lock.withLock { installed = newValue } }
    }
}
