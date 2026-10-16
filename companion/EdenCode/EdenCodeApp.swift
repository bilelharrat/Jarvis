import SwiftUI
import UIKit

/// Eden Code for iPhone: its own App Store app, on the same companion API, pairing, pinned
/// TLS and relay as the Eden companion (companion/Shared, iOS/Account's relay), with Eden
/// Code's own screens (docs/eden-code-phone.md).
@main
struct EdenCodeApp: App {
    @UIApplicationDelegateAdaptor(EdenCodeAppDelegate.self) private var delegate
    @State private var store = EdenCodeStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .onOpenURL { store.open(url: $0) }
                .onAppear {
                    #if DEBUG
                    if !EdenDebug.fixtures { PushRegistrar.shared.start(store: store) }
                    EdenDebugOpen.apply(store)
                    #else
                    PushRegistrar.shared.start(store: store)
                    #endif
                }
                .onChange(of: phase) { _, phase in
                    if phase == .active { store.startPolling() } else { store.stopPolling() }
                }
        }
    }
}

final class EdenCodeAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        if EdenDebug.reset { MacStore.save([]) }
        #endif
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrar.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
}

#if DEBUG
/// -EDENCODEOpen: the screen to show at launch (for screenshots).
enum EdenDebugOpen {
    @MainActor static func apply(_ store: EdenCodeStore) {
        guard let open = EdenDebug.open else { return }
        let parts = open.split(separator: ":").map(String.init)
        let id = parts.count > 1 ? Int(parts[1]) ?? 5 : 5
        switch parts.first {
        case "session": store.open(session: id)
        case "changes": store.openChanges(id)
        case "approve": store.sheetCard = store.home.attention.first
        case "inbox": store.tab = .inbox
        case "queue": store.tab = .queue
        case "settings": store.tab = .settings
        case "new": store.showNewSession = true
        case "pair": store.showPairing = true
        default: break
        }
    }
}
#endif
