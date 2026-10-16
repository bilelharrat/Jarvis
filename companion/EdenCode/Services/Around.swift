import ActivityKit
import Foundation
import UIKit
import UserNotifications
import WidgetKit

/// Push notifications: asks once, registers with APNs, and hands the token to every paired
/// Mac (the companion's /api/push/register, the same path the companion app uses; the Mac
/// sends needs-you, done, failed and the handoff with its own key, or through the account).
@MainActor
final class PushRegistrar: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushRegistrar()
    weak var store: EdenCodeStore?
    private(set) var token: String?

    func start(store: EdenCodeStore) {
        self.store = store
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task {
            let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func registerAgain() {
        guard let token else { return }
        Task { await store?.registerPush(token: token) }
    }

    func didRegister(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        Task { await store?.registerPush(token: hex) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { Task { await self.store?.refreshHome() } }
        return [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let sendable = info.reduce(into: [String: Any]()) { $0["\($1.key)"] = $1.value }
        nonisolated(unsafe) let payload = sendable
        await MainActor.run { self.store?.open(push: payload) }
    }
}

/// The Lock Screen and Dynamic Island for running sessions (the companion's Live Activity
/// attributes and plan, Activity/JarvisActivity.swift): started while the app is in front,
/// updated by the Mac's pushes through each activity's token (/api/live/register), ended
/// when the session stops working.
@MainActor
final class EdenLiveActivities {
    typealias Attributes = JarvisActivityAttributes
    private var watched: Set<String> = []

    func sync(_ sessions: [PhoneSummary], enabled: Bool, api: JarvisAPI?) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let summaries = enabled ? sessions.map { CodeSessionSummary(id: $0.id, title: $0.title, project: $0.project, status: $0.status) } : []
        let now = Date()
        var existing: [String: Attributes.ContentState] = [:]
        for activity in Activity<Attributes>.activities { existing[activity.attributes.key] = activity.content.state }
        let changes = LiveActivityPlan.changes(wanted: LiveActivityPlan.wanted(sessions: summaries, delegations: [], now: now),
                                               existing: existing, managing: [.code], sessions: summaries, now: now,
                                               canStart: UIApplication.shared.applicationState == .active)
        for (key, last) in changes.end {
            for activity in Activity<Attributes>.activities where activity.attributes.key == key {
                await activity.end(last.map { ActivityContent(state: $0, staleDate: nil) }, dismissalPolicy: last == nil ? .immediate : .default)
            }
        }
        for item in changes.update {
            for activity in Activity<Attributes>.activities where activity.attributes.key == item.key {
                await activity.update(ActivityContent(state: item.content, staleDate: now.addingTimeInterval(15 * 60)))
            }
        }
        for item in changes.start {
            let attributes = Attributes(kind: item.kind, itemID: item.itemID)
            if let activity = try? Activity.request(attributes: attributes, content: ActivityContent(state: item.content, staleDate: now.addingTimeInterval(15 * 60)),
                                                    pushType: .token) {
                watch(activity, api: api)
            }
        }
    }

    private func watch(_ activity: Activity<Attributes>, api: JarvisAPI?) {
        guard let api, !watched.contains(activity.id) else { return }
        watched.insert(activity.id)
        let key = activity.attributes.key
        let bundle = Bundle.main.bundleIdentifier ?? "com.askeden.jarvis.edencode"
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        Task {
            for await data in activity.pushTokenUpdates {
                let hex = data.map { String(format: "%02x", $0) }.joined()
                try? await api.registerLiveActivity(key, token: hex, environment: environment, bundleID: bundle)
            }
        }
    }
}

extension WidgetSnapshotStore {
    static func save(home: PhoneHome, mac: String) {
        let live = home.sessions.filter { $0.status.isLive }
        let snapshot = EdenWidgetSnapshot(
            mac: mac,
            needsYou: home.needsYouCount,
            working: home.sessions.filter { $0.status == .working }.count,
            items: (live + home.sessions.filter { !$0.status.isLive }).prefix(4).map {
                .init(id: $0.id, title: $0.title, project: $0.project, status: $0.status.rawValue)
            },
            at: Date()
        )
        guard snapshot.items != load()?.items || snapshot.needsYou != load()?.needsYou else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(snapshot) else { return }
        try? data.write(to: url, options: .atomic)
        WidgetCenter.shared.reloadTimelines(ofKind: "EdenCodeStatus")
    }
}
