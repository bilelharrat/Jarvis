import ActivityKit
import Foundation

/// Live Activities on the Lock Screen and in the Dynamic Island, started by the app when the
/// Mac's state (or a push, while the app is open) shows something going on, and updated by
/// the Mac's own pushes through each activity's push token.
@MainActor
final class LiveActivities {
    typealias Attributes = JarvisActivityAttributes

    static let shared = LiveActivities()

    private var watchers: [String: Task<Void, Never>] = [:]
    private var syncing = false
    private var delegations: [DelegationItem]?
    private var delegationsFetched = Date.distantPast

    private var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// At launch: follow the activities already showing (their push tokens can change).
    func resume() {
        for activity in Activity<Attributes>.activities { watch(activity) }
    }

    /// The Mac's state came in. In front, activities start; in the background, they're only
    /// updated and ended (iOS starts them only for an app in front).
    func sync(_ state: RemoteState, api: JarvisAPI, inForeground: Bool) async {
        guard allowed, !syncing else { return }
        syncing = true
        defer { syncing = false }
        let showingDelegation = Activity<Attributes>.activities.contains { $0.attributes.kind == .delegation }
        if state.delegationsActive > 0 || showingDelegation {
            if Date().timeIntervalSince(delegationsFetched) > 30 {  // at most twice a minute
                delegationsFetched = Date()
                if let items = try? await api.delegations() { delegations = items }
            }
        } else {
            delegations = []
        }
        let now = Date()
        let changes = LiveActivityPlan.changes(
            wanted: LiveActivityPlan.wanted(sessions: state.codeSessions, delegations: delegations, now: now),
            existing: existing(),
            managing: delegations == nil ? [.code] : [.code, .delegation],
            sessions: state.codeSessions, now: now, canStart: inForeground
        )
        await apply(changes)
    }

    /// A push arrived while the app is in front: a call or a video summary starts here, and
    /// a call's second push (how it went) ends it.
    func handle(_ push: JarvisPush) async {
        guard allowed, let (item, ends) = LiveActivityPlan.fromPush(push, existing: Set(existing().keys)) else { return }
        if ends {
            await apply(LiveActivityPlan.Changes(end: [item.key: item.content]))
        } else {
            await apply(LiveActivityPlan.Changes(start: [item]))
        }
    }

    /// Unpaired: nothing of that Mac's stays on screen.
    func endAll() async {
        for activity in Activity<Attributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    // MARK: - ActivityKit

    private func existing() -> [String: Attributes.ContentState] {
        var showing: [String: Attributes.ContentState] = [:]
        for activity in Activity<Attributes>.activities where activity.activityState == .active || activity.activityState == .stale {
            showing[activity.attributes.key] = activity.content.state
        }
        return showing
    }

    private func apply(_ changes: LiveActivityPlan.Changes) async {
        let activities = Activity<Attributes>.activities
        for (key, last) in changes.end {
            for activity in activities where activity.attributes.key == key {
                if let last {
                    await activity.end(ActivityContent(state: last, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(10 * 60)))
                } else {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
                watchers.removeValue(forKey: activity.id)?.cancel()
            }
        }
        for item in changes.update {
            for activity in activities where activity.attributes.key == item.key {
                await activity.update(ActivityContent(state: item.content, staleDate: Self.stale(item.content)))
            }
        }
        for item in changes.start {
            do {
                let activity = try Activity.request(
                    attributes: Attributes(kind: item.kind, itemID: item.itemID),
                    content: ActivityContent(state: item.content, staleDate: Self.stale(item.content)),
                    pushType: .token
                )
                watch(activity)
            } catch {
                // Turned off, too many, or not in front after all: the app and widgets still show it.
            }
        }
    }

    /// Dimmed when the Mac hasn't said anything about it for half an hour.
    private static func stale(_ content: Attributes.ContentState) -> Date {
        content.updated.addingTimeInterval(30 * 60)
    }

    /// Gives the Mac each push token the activity gets, so its updates reach it.
    private func watch(_ activity: Activity<Attributes>) {
        guard watchers[activity.id] == nil else { return }
        let key = activity.attributes.key
        watchers[activity.id] = Task {
            for await data in activity.pushTokenUpdates {
                guard let api = PairingStore.load().flatMap({ $0.isPinned ? $0.api : nil }) else { continue }
                _ = try? await api.registerLiveActivity(
                    key, token: PushToken.hex(data), environment: PushCoordinator.environment,
                    bundleID: Bundle.main.bundleIdentifier ?? ""
                )
            }
        }
    }
}
