import UIKit
import UserNotifications

/// Push notifications on the iPhone: permission, the device token the Mac pushes to, the
/// Mac's categories, and what happens when a notification arrives or is answered. An answer
/// (Allow, Not now, No because…) goes to the Mac from the background; the phone doesn't
/// have to open.
@MainActor
final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCoordinator()

    /// Where a tapped notification leads. Set by the app; a tap that launched the app is
    /// kept until then.
    var onOpen: ((Destination) -> Void)? {
        didSet {
            if let waiting = waitingDestination, let onOpen {
                waitingDestination = nil
                onOpen(waiting)
            }
        }
    }

    /// Something arrived that changes what the app shows.
    var onChange: (() -> Void)?

    private var waitingDestination: Destination?
    private(set) var token: String?
    private(set) var registrationProblem: String?

    /// What was last registered with the Mac: "<fingerprint>|<token>|<environment>".
    private static let sentKey = "push.registered"

    /// Debug builds get their tokens from APNs' sandbox; release builds (TestFlight, the
    /// App Store) from production.
    static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    /// At launch, before anything else can deliver a notification response.
    func launch() {
        UNUserNotificationCenter.current().delegate = self
        NotificationSetup.register()
        Task { await registerIfAllowed() }
    }

    /// Asks for permission (right after pairing, or from Settings), then registers.
    @discardableResult
    func enable() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    func authorization() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func registerIfAllowed() async {
        guard PairingStore.load()?.isPinned == true else { return }
        switch await authorization() {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    func didRegister(_ deviceToken: Data) {
        token = PushToken.hex(deviceToken)
        registrationProblem = nil
        Task { await sendToken(force: false) }
    }

    func registrationFailed(_ error: Error) {
        registrationProblem = error.localizedDescription
    }

    /// Tells the Mac where to push: when the token or the Mac changed, or the Mac says it
    /// has none for this device.
    func sendToken(force: Bool) async {
        guard let token, let pairing = PairingStore.load(), pairing.isPinned else { return }
        let key = "\(pairing.fingerprint ?? "")|\(token)|\(Self.environment)"
        if !force, UserDefaults.standard.string(forKey: Self.sentKey) == key { return }
        do {
            try await pairing.api.registerPush(token: token, environment: Self.environment, bundleID: Bundle.main.bundleIdentifier ?? "")
            UserDefaults.standard.set(key, forKey: Self.sentKey)
        } catch {
            // Tried again when /api/state says this device isn't registered.
        }
    }

    /// Unpairing: the Mac stops pushing here.
    func unregister(using api: JarvisAPI) async {
        UserDefaults.standard.removeObject(forKey: Self.sentKey)
        _ = try? await api.unregisterPush()
    }

    /// The app icon's badge: approvals waiting.
    func setBadge(_ count: Int) {
        Task {
            guard await authorization() == .authorized else { return }
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }

    /// A push with content-available woke the app in the background: bring the widgets
    /// (and anything waiting to be sent) up to date.
    func receivedInBackground(_ push: JarvisPush?) async {
        if let onChange {
            onChange()  // the app is up: its own refresh does the rest
        } else {
            await BackgroundRefresh.run()
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// In front: an approval still shows as a quiet banner (the card is on Home, which may be
    /// under a sheet); anything else as usual.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let push = JarvisPush(userInfo: notification.request.content.userInfo)
        if let push { await LiveActivities.shared.handle(push) }  // a call or a video summary starts here
        await MainActor.run { self.onChange?() }
        if push?.isApproval == true { return [.banner, .list] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let userInfo = content.userInfo
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        switch action {
        case UNNotificationDefaultActionIdentifier:
            guard let push = JarvisPush(userInfo: userInfo) else { return }
            await MainActor.run { self.open(Destination(push: push)) }
            await LiveActivities.shared.handle(push)
        case UNNotificationDismissActionIdentifier:
            return
        default:
            await answer(action: action, text: text, userInfo: userInfo)
        }
    }

    private func open(_ destination: Destination) {
        if let onOpen {
            onOpen(destination)
        } else {
            waitingDestination = destination  // launched by the tap: the app isn't up yet
        }
    }

    /// Sends the answer, with background time to do it in. When it can't reach the Mac, the
    /// notification comes back to try again.
    private nonisolated func answer(action: String, text: String?, userInfo: [AnyHashable: Any]) async {
        let background = await BackgroundTime.begin("Answer Jarvis")
        let api = PairingStore.load().flatMap { $0.isPinned ? $0.api : nil }
        let outcome = await NotificationActionHandler.handle(
            actionIdentifier: action, text: text, userInfo: userInfo, approve: NotificationActionHandler.approver(for: api)
        )
        if case .failed = outcome, let push = JarvisPush(userInfo: userInfo),
           let retry = NotificationActionHandler.retryContent(for: push, userInfo: userInfo) {
            let request = UNNotificationRequest(identifier: "retry-\(push.id)", content: retry, trigger: nil)
            try? await UNUserNotificationCenter.current().add(request)
        }
        await MainActor.run { self.onChange?() }
        await background.end()
    }
}

/// A little background time for work a notification action started.
@MainActor
final class BackgroundTime {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    static func begin(_ name: String) async -> BackgroundTime {
        let time = BackgroundTime()
        time.identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak time] in
            MainActor.assumeIsolated { time?.end() }
        }
        return time
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

/// The app's UIKit side: the notification delegate from launch, and the device token.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !TestHost.isRunningUnitTests else { return true }
        MainActor.assumeIsolated {
            PushCoordinator.shared.launch()
            LocationService.shared.resume()  // iOS may have relaunched the app for an arrival
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushCoordinator.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { PushCoordinator.shared.registrationFailed(error) }
    }

    func application(
        _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard !TestHost.isRunningUnitTests else { return completionHandler(.noData) }
        let push = JarvisPush(userInfo: userInfo)
        Task { @MainActor in
            await PushCoordinator.shared.receivedInBackground(push)
            completionHandler(.newData)
        }
    }
}
