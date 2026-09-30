import BackgroundTasks
import Foundation

/// While the app isn't open: now and then (background app refresh) and when a push wakes
/// it, it asks the Mac for its state to keep the widgets current, and sends what waited in
/// the outbox. No model calls: /api/state and the queued requests only.
enum BackgroundRefresh {
    static let identifier = "com.bshventures.jarvis.companion.refresh"

    /// About every twenty minutes, as iOS allows.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 20 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    @MainActor
    static func run() async {
        schedule()
        guard let pairing = PairingStore.load(), pairing.isPinned else { return }
        do {
            let state = try await pairing.api.state()
            SnapshotPublisher.shared.publish(state, macName: pairing.macLabel)
            await LiveActivities.shared.sync(state, api: pairing.api, inForeground: false)
            _ = await OutboxSender.drain(.shared, send: OutboxSender.sender(for: pairing.api))
            await HealthService.shared.sendIfDue()
        } catch {
            SnapshotPublisher.shared.markOffline()
        }
    }
}
