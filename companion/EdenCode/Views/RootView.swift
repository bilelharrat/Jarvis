import SwiftUI

/// Four tabs in iOS 26's floating glass tab bar (Sessions, Inbox, Queue, Settings), the
/// approval sheet over all of them, and pairing when no Mac is paired yet.
struct RootView: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Group {
            if store.paired {
                TabView(selection: $store.tab) {
                    Tab("Sessions", systemImage: "rectangle.stack", value: EdenCodeStore.Tab.sessions) {
                        NavigationStack(path: $store.path) {
                            SessionsView()
                                .navigationDestination(for: EdenCodeStore.Route.self) { route in
                                    switch route {
                                    case .session(let id): SessionScreen(id: id)
                                    case .changes(let id): ChangesScreen(id: id)
                                    }
                                }
                        }
                    }
                    Tab("Inbox", systemImage: "tray", value: EdenCodeStore.Tab.inbox) {
                        NavigationStack { InboxView() }
                    }
                    .badge(store.home.needsYouCount)
                    Tab("Queue", systemImage: "list.bullet", value: EdenCodeStore.Tab.queue) {
                        NavigationStack { QueueView() }
                    }
                    Tab("Settings", systemImage: "gearshape", value: EdenCodeStore.Tab.settings) {
                        NavigationStack { SettingsView() }
                    }
                }
                .tint(EdenTheme.accent)
                .overlay { ApprovalOverlay() }
                .sheet(isPresented: $store.showNewSession) {
                    NewSessionSheet()
                }
            } else {
                PairingView(first: true)
            }
        }
        .sheet(isPresented: $store.showPairing) {
            NavigationStack { PairingView(first: false) }
        }
    }
}
