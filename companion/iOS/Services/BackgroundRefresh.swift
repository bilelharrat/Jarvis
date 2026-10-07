import BackgroundTasks
import Foundation

/// While the app isn't open: now and then (background app refresh) and when a push wakes
/// it, it asks the Mac for its state to keep the widgets current, sends what waited in the
/// outbox, answers the Mac's asks of the contacts and calendar (when those are on) and sends
/// the calendar when it's due. No model calls: /api/state and the queued requests only.
enum BackgroundRefresh {
    static let identifier = "com.askeden.jarvis.refresh"

    /// About every twenty minutes, as iOS allows.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 20 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    @MainActor
    static func run() async {
        guard !TestHost.isRunningUnitTests else { return }  // the test host stays still
        schedule()
        await HeadsUpCenter.shared.refresh(foreground: false)  // when to leave, clashes: notified if it matters
        guard let pairing = PairingStore.load(), pairing.isPinned else { return }
        do {
            let state = try await pairing.api.state()
            SnapshotPublisher.shared.publish(state, macName: pairing.macLabel)
            await LiveActivities.shared.sync(state, api: pairing.api, inForeground: false)
            _ = await OutboxSender.drain(.shared, send: OutboxSender.sender(for: pairing.api))
            await HealthService.shared.sendIfDue()
            await PhoneSensors.shared.answer(state.phoneAsks, using: pairing.api)  // a silent push's ask
            await PhoneSensors.shared.sendCalendarIfDue(using: pairing.api)
        } catch {
            SnapshotPublisher.shared.markOffline()
        }
    }
}
