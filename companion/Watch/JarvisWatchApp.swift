import SwiftUI

@main
struct JarvisWatchApp: App {
    @State private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environment(model)
                .tint(Palette.cyan)
        }
    }
}

struct WatchRootView: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.pairing == nil {
                WatchUnpairedView()
            } else {
                WatchHomeView()
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            model.setActive(phase == .active)
        }
    }
}
