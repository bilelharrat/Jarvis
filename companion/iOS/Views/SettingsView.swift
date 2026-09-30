import SwiftUI

/// The Mac's address, spoken replies, the Watch, and unpairing: inset grouped, like the
/// Settings app, on glass.
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
                    identity
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)

                Section {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "network")
                        TextField("Mac address", text: $address)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit(saveAddress)
                            .foregroundStyle(Palette.ink)
                            .accessibilityLabel("Mac address")
                    }
                    if address.trimmed != (model.pairing?.address ?? "") {
                        Button("Use this address", action: saveAddress)
                            .foregroundStyle(Palette.cyan)
                    }
                    if let addressError {
                        Text(addressError)
                            .font(.footnote)
                            .foregroundStyle(Palette.amber)
                    }
                    if let fingerprint = model.pairing?.shortFingerprint {
                        LabeledContent {
                            Text(fingerprint)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(Palette.ink2)
                                .textSelection(.enabled)
                        } label: {
                            HStack(spacing: Space.s) {
                                IconTile(symbol: "lock.shield.fill")
                                Text("Certificate")
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    header("Your Mac")
                } footer: {
                    footer("Shown in Jarvis on your Mac under Settings › iPhone & Watch, with the same certificate fingerprint. Only that certificate is trusted, at any address. Away from home, use the Mac’s Tailscale address.")
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)

                Section {
                    Toggle(isOn: $model.speakReplies) {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "waveform")
                            Text("Speak replies")
                        }
                    }
                    .accessibilityLabel("Speak replies")
                } header: {
                    header("Voice")
                } footer: {
                    footer("Plays replies to what you ask here in Jarvis’s own voice, made on your Mac. The Mac itself stays quiet.")
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)

                Section {
                    LabeledContent {
                        Text(watchText)
                            .foregroundStyle(Palette.ink2)
                    } label: {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "applewatch")
                            Text("Apple Watch")
                        }
                    }
                    .accessibilityElement(children: .combine)
                    Button("Send pairing to Watch") { model.resendToWatch() }
                        .foregroundStyle(model.pairing == nil || !model.watchStatus.installed ? Palette.muted : Palette.cyan)
                        .disabled(model.pairing == nil || !model.watchStatus.installed)
                } header: {
                    header("Watch")
                } footer: {
                    footer("The JARVIS Watch app uses this iPhone’s pairing and talks to the Mac on its own.")
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)

                Section {
                    Button(role: .destructive) {
                        confirmUnpair = true
                    } label: {
                        Text("Unpair this iPhone")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.danger)
                            .frame(maxWidth: .infinity)
                    }
                    .accessibilityLabel("Unpair this iPhone")
                } footer: {
                    footer("Forgets the Mac on this iPhone and Watch. To shut this phone out for good, also remove it in Jarvis Settings › iPhone & Watch on the Mac.")
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)

                Section {
                    LabeledContent("Paired as", value: model.pairing?.deviceName ?? "—")
                    if let date = model.pairing?.pairedAt {
                        LabeledContent("Since", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                    LabeledContent("Version", value: Self.version)
                } header: {
                    header("About")
                }
                .listRowBackground(rowGlass)
                .listRowSeparatorTint(Palette.hairline)
            }
            .scrollContentBackground(.hidden)
            .listSectionSpacing(Space.l)
            .environment(\.defaultMinListRowHeight, 52)
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.05)))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
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

    /// The Mac this iPhone belongs to, like the account card at the top of Settings.
    private var identity: some View {
        HStack(spacing: Space.m) {
            ZStack {
                Circle()
                    .fill(Palette.ring.opacity(0.07))
                    .frame(width: 66, height: 66)
                Circle()
                    .fill(Palette.ring.opacity(0.10))
                    .frame(width: 54, height: 54)
                OrbMark(size: 42)
            }
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(model.pairing?.macLabel ?? "Your Mac")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    StateIndicator(state: model.isOffline ? nil : model.remote?.state)
                    Text(statusText)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Space.xs)
        .accessibilityElement(children: .combine)
    }

    private func header(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Palette.muted)
            .textCase(.uppercase)
            .tracking(0.6)
    }

    private func footer(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.muted)
    }

    /// Glass rows with a specular top edge, grouped by the Form's own continuous corners.
    private var rowGlass: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Rectangle().fill(Palette.spaceRaised.opacity(0.66)))
            .overlay(Rectangle().fill(Color.white.opacity(0.035)))
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
