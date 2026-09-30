import Foundation
import WatchConnectivity

/// Hands the Watch the Mac's address and token (WatchConnectivity application context,
/// and a reply when the Watch asks), so it can talk to the Mac on its own.
final class PhoneWatchBridge: NSObject, WCSessionDelegate {
    struct Status: Equatable, Sendable {
        var supported = false
        var paired = false
        var installed = false
        var lastSent: Date?
    }

    /// Called on the main actor when the Watch's status changes.
    var onStatus: (@MainActor (Status) -> Void)?

    private let lock = NSLock()
    private var context: [String: Any] = WatchLink.context(for: nil)
    private var ready = false  // push() has been called at least once
    private var lastSent: Date?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// The pairing the Watch should use (nil: unpaired).
    func push(_ pairing: Pairing?) {
        lock.withLock {
            context = WatchLink.context(for: pairing)
            ready = true
        }
        send()
    }

    /// What the complications show, when one is on the Watch face (the system allows a
    /// few dozen of these a day, so only when it changed).
    func send(snapshot: WidgetSnapshot) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled,
              session.isComplicationEnabled, session.remainingComplicationUserInfoTransfers > 0,
              let info = WatchLink.userInfo(for: snapshot) else { return }
        session.transferCurrentComplicationUserInfo(info)
    }

    private func send() {
        guard WCSession.isSupported() else { return report() }
        let session = WCSession.default
        let (context, ready) = lock.withLock { (self.context, self.ready) }
        guard ready, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
            return report()
        }
        do {
            try session.updateApplicationContext(context)
            lock.withLock { lastSent = Date() }
        } catch {
            // Not paired/installed after all, or WatchConnectivity is busy: the Watch asks
            // for it itself when it opens.
        }
        report()
    }

    private func report() {
        let status: Status
        if WCSession.isSupported() {
            let session = WCSession.default
            let activated = session.activationState == .activated
            status = Status(
                supported: true,
                paired: activated && session.isPaired,
                installed: activated && session.isWatchAppInstalled,
                lastSent: lock.withLock { lastSent }
            )
        } else {
            status = Status()
        }
        let onStatus = onStatus
        Task { @MainActor in onStatus?(status) }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        send()
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()  // switched to another watch
    }

    func sessionWatchStateDidChange(_ session: WCSession) {
        send()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard message[WatchLink.requestKey] as? String == WatchLink.pairingRequest else {
            return replyHandler([:])
        }
        replyHandler(lock.withLock { ready ? context : [:] })
    }
}
