import AppIntents
import Foundation

/// "Hey Siri, Eden Secretary", the Action Button, a Control Center or Lock Screen control, Back Tap
/// or a Vocal Shortcut ("Hey Eden", trained in iOS): opens Eden Secretary already
/// listening. In the app and the widget extension, so a control can run it; it always runs
/// in the app.
struct TalkToJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Eden Secretary"
    static let description = IntentDescription("Opens Eden Secretary, listening for what you want.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @MainActor
    func perform() async throws -> some IntentResult {
        ListenRequest.post()
        return .result()
    }
}

/// Hands "start listening" to the app, whether it was already running or is just launching.
enum ListenRequest {
    static let notification = Notification.Name("JarvisListenRequested")
    /// Set until the app's model takes it (a cold launch: the model may not exist yet).
    @MainActor static var pending = false

    @MainActor
    static func post() {
        pending = true
        NotificationCenter.default.post(name: notification, object: nil)
    }
}
