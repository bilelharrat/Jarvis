import SwiftUI

/// The app: Jarvis (the conversation), Today (what's going on), Code (Jarvis Code on the
/// Mac) and Library (everything else), in the system tab bar.
struct MainTabs: View {
    @Environment(AppModel.self) private var model
    @State private var tab: AppTab = .jarvis
    @State private var libraryPath: [Destination] = []
    @State private var codePath: [Destination] = []
    @State private var showSettings = false
    @State private var showOutbox = false

    enum AppTab: Hashable {
        case jarvis, today, code, library
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Jarvis", systemImage: "sparkle", value: AppTab.jarvis) {
                JarvisView(showSettings: $showSettings, showOutbox: $showOutbox)
            }
            Tab("Today", systemImage: "sun.horizon", value: AppTab.today) {
                TodayView(showSettings: $showSettings) { destination in open(destination) }
            }
            .badge(model.visibleApprovals.count)
            if model.pairing != nil {
                Tab("Code", systemImage: "chevron.left.forwardslash.chevron.right", value: AppTab.code) {
                    NavigationStack(path: $codePath) {
                        CodeSessionsView()
                            .navigationDestination(for: Destination.self) { LibraryView.screen(for: $0) }
                    }
                }
                .badge(codeNeedsYou)
            }
            Tab("Library", systemImage: "square.grid.2x2", value: AppTab.library) {
                NavigationStack(path: $libraryPath) {
                    LibraryView(showSettings: $showSettings)
                        .navigationDestination(for: Destination.self) { LibraryView.screen(for: $0) }
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showOutbox) {
            OutboxSheet()
        }
        .sheet(isPresented: Binding(get: { model.showAccount }, set: { model.showAccount = $0 })) {
            NavigationStack {
                AccountView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done", systemImage: "checkmark") { model.showAccount = false }
                        }
                    }
            }
        }
        .onChange(of: model.showAccount) { _, showing in
            if showing { showSettings = false }  // one sheet at a time
        }
        .overlay(alignment: .top) {
            if let toast = model.toast {
                ToastView(toast: toast, onDismiss: model.dismissToast)
                    .padding(.horizontal, Space.m)
                    .padding(.top, Space.xs)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.toast)
        .onChange(of: model.destination, initial: true) { _, destination in
            guard let destination else { return }
            model.destination = nil
            open(destination)
        }
    }

    private var codeNeedsYou: Int {
        model.remote?.codeSessions.filter { $0.status == .needsYou }.count ?? 0
    }

    private func open(_ destination: Destination) {
        showSettings = false
        switch destination {
        case .home:
            tab = .jarvis
        case .outbox:
            showOutbox = true
        case .code:
            tab = model.pairing != nil ? .code : .library
            codePath = []
        case .codeSession:
            tab = .code
            codePath = [destination]
        default:
            tab = .library
            libraryPath = [destination]
        }
    }
}
