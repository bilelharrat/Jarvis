import SwiftUI

@main
struct JarvisCompanionApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Palette.cyan)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        }
    }
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
    }
}
