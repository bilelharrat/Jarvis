import Foundation
import UserNotifications

/// The notification categories the Mac's pushes use, registered by the iPhone and the Watch
/// at launch (the companion contract). A yes needs an unlocked device (or a Watch on the
/// wrist); a no never does.
enum NotificationSetup {
    static func categories() -> Set<UNNotificationCategory> {
        [
            approvalCategory(NotificationCategories.approval, yes: "Allow", no: "Not now"),
            approvalCategory(NotificationCategories.codeApproval, yes: "Yes", no: "No"),
            UNNotificationCategory(identifier: NotificationCategories.headsUp, actions: [], intentIdentifiers: [], options: []),
        ]
    }

    private static func approvalCategory(_ identifier: String, yes: String, no: String) -> UNNotificationCategory {
        let allow = UNNotificationAction(identifier: NotificationCategories.allow, title: yes, options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: NotificationCategories.deny, title: no, options: [.destructive])
        let reason = UNTextInputNotificationAction(
            identifier: NotificationCategories.denyReason, title: "No, because…", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "What should Jarvis do instead?"
        )
        #if os(iOS)
        return UNNotificationCategory(
            identifier: identifier, actions: [allow, deny, reason], intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "Jarvis needs your OK", options: []
        )
        #else
        return UNNotificationCategory(identifier: identifier, actions: [allow, deny, reason], intentIdentifiers: [], options: [])
        #endif
    }

    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories(categories())
    }
}

/// Answers an approval from a notification action, on the iPhone or the Watch, within the
/// few seconds the system gives a background action.
enum NotificationActionHandler {
    enum Outcome: Equatable, Sendable {
        case answered
        /// The Mac had already dropped it (answered elsewhere, or timed out).
        case alreadyAnswered
        /// Not an action on an approval (a tap, a dismiss, a heads-up).
        case notAnAnswer
        case notPaired
        case failed(JarvisError)
    }

    /// How long to wait for the Mac, inside the ~30 s a background action gets.
    static let timeout: TimeInterval = 20

    typealias Approve = @Sendable (_ id: String, _ choice: String, _ feedback: String?) async throws -> Bool

    /// The request an action means, before sending it: nil when it isn't an answer.
    static func request(actionIdentifier: String, text: String?, userInfo: [AnyHashable: Any]) -> (id: String, sent: ApprovalResponse.Sent)? {
        guard let push = JarvisPush(userInfo: userInfo), push.isApproval, !push.id.isEmpty,
              let answer = ApprovalResponse.answer(forAction: actionIdentifier, text: text) else { return nil }
        return (push.id, ApprovalResponse.choice(for: answer, choices: push.choices))
    }

    static func handle(actionIdentifier: String, text: String?, userInfo: [AnyHashable: Any], approve: Approve?) async -> Outcome {
        guard let (id, sent) = request(actionIdentifier: actionIdentifier, text: text, userInfo: userInfo) else { return .notAnAnswer }
        guard let approve else { return .notPaired }
        do {
            return try await approve(id, sent.choice, sent.feedback) ? .answered : .alreadyAnswered
        } catch let error as JarvisError {
            return .failed(error)
        } catch {
            return .failed(.unreachable(error.localizedDescription))
        }
    }

    /// Through a pinned API.
    static func approver(for api: JarvisAPI?) -> Approve? {
        guard let api else { return nil }
        return { id, choice, feedback in
            try await api.approve(id: id, choice: choice, feedback: feedback, timeout: timeout)
        }
    }

    /// When the answer didn't reach the Mac and the card may still be open (the Mac waits
    /// five minutes), the notification comes back so it can be tried again.
    static func retryContent(for push: JarvisPush, userInfo: [AnyHashable: Any], now: Date = Date()) -> UNNotificationContent? {
        guard push.isApproval, now.timeIntervalSince(push.at ?? now) < 290 else { return nil }
        let content = UNMutableNotificationContent()
        content.title = push.title.isEmpty ? "Jarvis needs your OK" : push.title
        content.body = "Your Mac didn’t get that answer. Try again, or open J.A.R.V.I.S."
        content.categoryIdentifier = push.kind == .codeApproval ? NotificationCategories.codeApproval : NotificationCategories.approval
        content.userInfo = userInfo
        content.sound = .default
        return content
    }
}

enum PushToken {
    /// APNs tokens as the Mac wants them: lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}
