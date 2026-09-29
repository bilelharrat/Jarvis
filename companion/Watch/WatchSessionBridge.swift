import Foundation
import WatchConnectivity

/// Receives the Mac's address and token from the iPhone (application context), and can
/// ask the iPhone for them when the Watch app opens without any.
final class WatchSessionBridge: NSObject, WCSessionDelegate {
    /// Called on the main actor with what the iPhone sent.
    var onUpdate: (@MainActor (WatchLink.Update) -> Void)?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Ask the iPhone for its pairing, if it's reachable right now.
    func requestPairing() {
        let session = WCSession.default
        guard WCSession.isSupported(), session.activationState == .activated, session.isReachable else { return }
        session.sendMessage([WatchLink.requestKey: WatchLink.pairingRequest], replyHandler: { [weak self] reply in
            self?.deliver(WatchLink.update(from: reply))
        }, errorHandler: { _ in
            // Not reachable after all: the application context arrives when it can.
        })
    }

    private func deliver(_ update: WatchLink.Update) {
        guard update != .nothing else { return }
        let onUpdate = onUpdate
        Task { @MainActor in onUpdate?(update) }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        deliver(WatchLink.update(from: session.receivedApplicationContext))
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        deliver(WatchLink.update(from: applicationContext))
    }
}
