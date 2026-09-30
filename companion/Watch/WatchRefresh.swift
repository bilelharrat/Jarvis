import Foundation
import WatchKit

/// Keeps the complications current while the Watch app isn't open: about every half hour
/// (as watchOS allows) it asks the Mac for its state. /api/state only, no model calls.
@MainActor
enum WatchRefresh {
    static func schedule() {
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: Date(timeIntervalSinceNow: 30 * 60), userInfo: nil) { _ in }
    }

    static func run() async {
        schedule()
        guard let pairing = PairingStore.load(), pairing.isPinned else { return }
        do {
            SnapshotPublisher.shared.publish(try await pairing.api.state(), macName: pairing.macLabel)
        } catch {
            SnapshotPublisher.shared.markOffline()
        }
    }
}

extension WatchAppDelegate {
    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            switch task {
            case let refresh as WKApplicationRefreshBackgroundTask:
                Task { @MainActor in
                    await WatchRefresh.run()
                    refresh.setTaskCompletedWithSnapshot(false)
                }
            case let connectivity as WKWatchConnectivityRefreshBackgroundTask:
                // What the iPhone sent arrives through the session's delegate: give it a moment.
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    connectivity.setTaskCompletedWithSnapshot(false)
                }
            default:
                task.setTaskCompletedWithSnapshot(false)
            }
        }
    }
}
