import SwiftUI

@main
struct JarvisCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// Hosting unit tests, the app stays still: no pairing, no network, no Watch.
    @State private var model: AppModel? = TestHost.isRunningUnitTests ? nil : AppModel()

    var body: some Scene {
        WindowGroup {
            if let model {
                RootView()
                    .environment(model)
                    .preferredColorScheme(.dark)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
            } else {
                Palette.space.ignoresSafeArea()
            }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
    }
}

enum TestHost {
    /// The app was launched to host the unit tests (not the UI test, which drives it for real).
    static let isRunningUnitTests: Bool = {
        let environment = ProcessInfo.processInfo.environment
        return environment["XCTestConfigurationFilePath"] != nil || environment["XCTestBundlePath"] != nil
    }()
}

/// The welcome until there's something to talk to (a Mac, or a key for the iPhone), then
/// the app. Polls the Mac only while the app is in front.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            if model.needsSetup {
                WelcomeView()
                    .transition(.opacity)
            } else {
                MainTabs()
                    .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.5), value: model.needsSetup)
        .onChange(of: scenePhase, initial: true) { _, phase in
            model.setForeground(phase == .active)
        }
        .onOpenURL { url in model.open(url) }
        .alert(
            model.offeredLink.map { "Pair with \($0.label)?" } ?? "",
            isPresented: Binding(get: { model.offeredLink != nil }, set: { if !$0 { model.offeredLink = nil } }),
            presenting: model.offeredLink
        ) { _ in
            Button("Pair") { Task { await model.acceptOfferedLink() } }
            Button("Cancel", role: .cancel) { model.offeredLink = nil }
        } message: { link in
            Text(offerMessage(link))
        }
    }

    private func offerMessage(_ link: PairingLink) -> String {
        var text = "\(MacAddress.display(link.baseURL)), fingerprint \(CertificatePin.short(link.fingerprint))."
        if let current = model.pairing {
            text += " This replaces the pairing with \(current.macLabel)."
        }
        return text
    }
}
