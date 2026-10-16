import SwiftUI

/// Settings: the Macs (switch, pair another, unpair), how away-from-home works, spoken
/// replies, Live Activities, and the usage glance in full.
struct SettingsView: View {
    @Environment(EdenCodeStore.self) private var store
    @State private var removing: Pairing?

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                ForEach(store.macs, id: \.baseURL) { mac in
                    Button { store.select(mac) } label: {
                        HStack {
                            Image(systemName: "desktopcomputer").foregroundStyle(EdenTheme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mac.macLabel).foregroundStyle(EdenTheme.ink)
                                Text([mac.address, mac.shortFingerprint].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(EdenTheme.muted)
                            }
                            Spacer()
                            if store.current.map({ PairingStore.same($0, mac) }) ?? false {
                                Image(systemName: "checkmark").foregroundStyle(EdenTheme.accent)
                            }
                        }
                    }
                    .swipeActions { Button("Unpair", role: .destructive) { removing = mac } }
                }
                Button { store.showPairing = true } label: { Label("Pair another Mac", systemImage: "plus") }
            } header: {
                Text("Macs")
            } footer: {
                Text("Away from home, Eden Code reaches your Mac through Eden’s encrypted relay when this iPhone is signed in to your Eden account in the Eden app, or over Tailscale.")
            }
            Section("Reading aloud") {
                Toggle("Read replies aloud as they come", isOn: $store.speakReplies)
            }
            Section("Lock Screen") {
                Toggle("Live Activities for running sessions", isOn: $store.liveActivitiesOn)
            }
            if let usage = store.usage {
                Section("Usage") {
                    LabeledContent("Today", value: Money.text(usage.today))
                    if usage.dayCap > 0 { LabeledContent("Daily cap", value: Money.text(usage.dayCap)) }
                    LabeledContent("Last 7 days", value: Money.text(usage.week))
                    ForEach(usage.windows, id: \.self) { window in
                        LabeledContent(window.label, value: window.percent.map { "\(Int($0.rounded()))%" } ?? "—")
                    }
                }
            }
            Section {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
            }
        }
        .scrollContentBackground(.hidden)
        .background(EdenBackground())
        .navigationTitle("Settings")
        .task { await store.refreshUsage() }
        .confirmationDialog("Unpair \(removing?.macLabel ?? "this Mac")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { if let removing { store.remove(removing) } }
        } message: {
            Text("Eden Code on this iPhone forgets it. Remove the device on the Mac too, in Settings › iPhone & Watch.")
        }
    }
}
