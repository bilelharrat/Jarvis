import UserNotifications
import WatchKit

/// The Watch's side of the Mac's notifications. iPhone notifications appear on the Watch by
/// themselves; when an answer (Allow, Not now, No because… by dictation) is delivered here,
/// the Watch sends it to the Mac itself, with the pairing the iPhone gave it.
final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        NotificationSetup.register()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        guard action != UNNotificationDefaultActionIdentifier, action != UNNotificationDismissActionIdentifier else { return }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let api = PairingStore.load().flatMap { $0.isPinned ? $0.api : nil }
        let outcome = await NotificationActionHandler.handle(
            actionIdentifier: action, text: text, userInfo: userInfo, approve: NotificationActionHandler.approver(for: api)
        )
        switch outcome {
        case .answered, .alreadyAnswered:
            WKInterfaceDevice.current().play(action == NotificationCategories.allow ? .success : .directionDown)
        case .failed:
            WKInterfaceDevice.current().play(.failure)
            if let push = JarvisPush(userInfo: userInfo), let retry = NotificationActionHandler.retryContent(for: push, userInfo: userInfo),
               await center.notificationSettings().authorizationStatus == .authorized {
                try? await center.add(UNNotificationRequest(identifier: "retry-\(push.id)", content: retry, trigger: nil))
            }
        case .notAnAnswer, .notPaired:
            break
        }
    }
}
