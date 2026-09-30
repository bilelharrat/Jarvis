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
                    .tint(Palette.cyan)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            } else {
                Palette.space.ignoresSafeArea()
            }
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

/// Pairing until there's a Mac, then home. Polls only while the app is in front.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            if model.pairing == nil {
                PairingView()
                    .transition(.opacity.combined(with: .scale(scale: 1.03)))
            } else {
                HomeView()
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .animation(.spring(response: 0.6, dampingFraction: 0.9), value: model.pairing == nil)
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
