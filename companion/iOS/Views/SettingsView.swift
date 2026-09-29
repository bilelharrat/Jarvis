import SwiftUI

/// The Mac's address, spoken replies, the Watch, and unpairing.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var addressError: String?
    @State private var confirmUnpair = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    if let name = model.pairing?.macName, !name.isEmpty {
                        LabeledContent("Name", value: name)
                    }
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            StateIndicator(state: model.isOffline ? nil : model.remote?.state)
                            Text(statusText)
                        }
                    }
                    TextField("Mac address", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(saveAddress)
                        .accessibilityLabel("Mac address")
                    if address.trimmed != (model.pairing?.address ?? "") {
                        Button("Use this address", action: saveAddress)
                    }
                    if let addressError {
                        Text(addressError)
                            .font(.footnote)
                            .foregroundStyle(Palette.amber)
                    }
                } header: {
                    Text("Your Mac")
                } footer: {
                    Text("Shown in Jarvis on your Mac under Settings › iPhone & Watch. Away from home, use the Mac’s Tailscale address (100.x.x.x).")
                }
                .listRowBackground(rowGlass)

                Section {
                    Toggle("Speak replies", isOn: $model.speakReplies)
                } header: {
                    Text("Voice")
                } footer: {
                    Text("Plays replies to what you ask here in Jarvis’s own voice, made on your Mac. The Mac itself stays quiet.")
                }
                .listRowBackground(rowGlass)

                Section {
                    LabeledContent("Apple Watch", value: watchText)
                    Button("Send pairing to Watch") { model.resendToWatch() }
                        .disabled(model.pairing == nil || !model.watchStatus.installed)
                } header: {
                    Text("Watch")
                } footer: {
                    Text("The JARVIS Watch app uses this iPhone’s pairing and talks to the Mac on its own.")
                }
                .listRowBackground(rowGlass)

                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("Forgets the Mac on this iPhone and Watch. To shut this phone out for good, also remove it in Jarvis Settings › iPhone & Watch on the Mac.")
                }
                .listRowBackground(rowGlass)

                Section {
                    LabeledContent("Paired as", value: model.pairing?.deviceName ?? "—")
                    if let date = model.pairing?.pairedAt {
                        LabeledContent("Since", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                    LabeledContent("Version", value: Self.version)
                }
                .listRowBackground(rowGlass)
            }
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 50)
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0)))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    model.unpair()
                }
            } message: {
                Text("You’ll need a new code from the Mac to pair again.")
            }
        }
        .onAppear { address = model.pairing?.address ?? "" }
    }

    /// Navy glass rows with a cyan hairline, like the rest of the app.
    private var rowGlass: some View {
        Rectangle()
            .fill(Palette.spaceRaised.opacity(0.92))
            .overlay(alignment: .bottom) {
                Rectangle().fill(Palette.ring.opacity(0.10)).frame(height: 0.5)
            }
    }

    private func saveAddress() {
        do {
            try model.changeAddress(to: address)
            addressError = nil
            address = model.pairing?.address ?? address
        } catch {
            addressError = (error as? JarvisError)?.message ?? error.localizedDescription
        }
    }

    private var statusText: String {
        switch model.link {
        case .online: model.remote.map { "Connected · \($0.state.label)" } ?? "Connected"
        case .connecting: "Connecting…"
        case .unreachable: "Can’t reach the Mac"
        }
    }

    private var watchText: String {
        let status = model.watchStatus
        guard status.supported else { return "Not supported" }
        guard status.paired else { return "No Watch paired" }
        guard status.installed else { return "App not installed" }
        if let sent = status.lastSent {
            return "Up to date · \(sent.formatted(date: .omitted, time: .shortened))"
        }
        return "Installed"
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}
