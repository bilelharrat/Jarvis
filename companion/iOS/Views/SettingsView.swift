import SwiftUI
import UserNotifications

/// Your Mac, Jarvis on this iPhone, voice and "Hey Jarvis", notifications, sensors, the
/// Watch: grouped like the Settings app.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var addressError: String?
    @State private var confirmUnpair = false
    @State private var notifications: UNAuthorizationStatus?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    identity
                }

                if model.pairing != nil {
                    macSection
                } else {
                    Section {
                        NavigationLink {
                            PairingView()
                        } label: {
                            HStack(spacing: Space.s) {
                                IconTile(symbol: "desktopcomputer", tint: .blue)
                                Text("Pair with Your Mac")
                            }
                        }
                    } header: {
                        Text("Your Mac")
                    } footer: {
                        Text("With Jarvis on your Mac paired, this iPhone reaches everything it does: Jarvis Code, your files, mail, iMessage, routines and its own voice.")
                    }
                }

                PhoneBrainSettings()

                Section {
                    Toggle(isOn: $model.speakReplies) {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "speaker.wave.2.fill", tint: .pink)
                            Text("Speak Replies")
                        }
                    }
                    NavigationLink {
                        HeyJarvisView()
                    } label: {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "waveform", tint: .purple)
                            Text("“Hey Jarvis” and the Action Button")
                        }
                    }
                } header: {
                    Text("Voice")
                } footer: {
                    Text(model.pairing == nil
                        ? "Replies are spoken in the iPhone’s best installed voice. For a better one, download an Enhanced or Premium voice in Settings › Accessibility › Spoken Content › Voices."
                        : "Replies are spoken in Jarvis’s own voice, made on your Mac, or in the iPhone’s best voice when the Mac can’t be reached.")
                }

                if model.pairing != nil {
                    notificationsSection
                }

                SensorSettings()

                if model.pairing != nil {
                    watchSection
                    Section {
                        Button("Unpair This iPhone", role: .destructive) {
                            confirmUnpair = true
                        }
                        .frame(maxWidth: .infinity)
                    } footer: {
                        Text("Forgets the Mac on this iPhone and Watch. To shut this phone out for good, also remove it in Jarvis Settings › iPhone & Watch on the Mac.")
                    }
                }

                Section("About") {
                    if let pairing = model.pairing {
                        LabeledContent("Paired As", value: pairing.deviceName ?? "iPhone")
                        LabeledContent("Since", value: pairing.pairedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                    LabeledContent("Version", value: Self.version)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
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
        .task { notifications = await PushCoordinator.shared.authorization() }
    }

    private var macSection: some View {
        Section {
            HStack(spacing: Space.s) {
                IconTile(symbol: "network", tint: .blue)
                TextField("Mac address", text: $address)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(saveAddress)
                    .accessibilityLabel("Mac address")
            }
            if model.macFeatures.contains("prefs") {
                NavigationLink {
                    MacPrefsView()
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "slider.horizontal.3", tint: .gray)
                        Text("Jarvis on Your Mac")
                    }
                }
            }
            if address.trimmed != (model.pairing?.address ?? "") {
                Button("Use This Address", action: saveAddress)
            }
            if let addressError {
                Text(addressError)
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
            }
            if let fingerprint = model.pairing?.shortFingerprint {
                LabeledContent {
                    Text(fingerprint)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "lock.shield.fill", tint: .green)
                        Text("Certificate")
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Your Mac")
        } footer: {
            Text("Shown in Jarvis on your Mac under Settings › iPhone & Watch, with the same certificate fingerprint. Only that certificate is trusted, at any address. Away from home, use the Mac’s Tailscale address.")
        }
    }

    private var notificationsSection: some View {
        Section {
            LabeledContent {
                Text(notificationText)
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "bell.badge.fill", tint: .red)
                    Text("Notifications")
                }
            }
            .accessibilityElement(children: .combine)
            if notifications == .notDetermined {
                Button("Turn On Notifications") {
                    Task {
                        await PushCoordinator.shared.enable()
                        notifications = await PushCoordinator.shared.authorization()
                    }
                }
            } else if notifications == .denied {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        } footer: {
            Text("Approvals, Jarvis Code and heads-ups from your Mac, with Allow, Not now and No, because… right on the notification, here and on your Apple Watch. Allowing needs your iPhone unlocked.")
        }
    }

    private var watchSection: some View {
        Section {
            LabeledContent {
                Text(watchText)
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "applewatch", tint: .gray)
                    Text("Apple Watch")
                }
            }
            .accessibilityElement(children: .combine)
            Button("Send Pairing to Watch") { model.resendToWatch() }
                .disabled(!model.watchStatus.installed)
        } footer: {
            Text("The JARVIS Watch app uses this iPhone’s pairing and talks to the Mac on its own.")
        }
    }

    /// Jarvis, like the account card at the top of Settings.
    private var identity: some View {
        HStack(spacing: Space.m) {
            OrbMark(size: 58)
            VStack(alignment: .leading, spacing: 2) {
                Text("J.A.R.V.I.S.")
                    .font(.title2.weight(.semibold))
                HStack(spacing: 6) {
                    if model.pairing != nil {
                        StateIndicator(state: model.isOffline ? nil : model.remote?.state)
                    }
                    Text(statusText)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Space.xxs)
        .accessibilityElement(children: .combine)
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
        guard model.pairing != nil else { return model.hasPhoneKey ? "On this iPhone" : "Not set up" }
        return switch model.link {
        case .online: model.remote.map { "Connected · \($0.state.label)" } ?? "Connected"
        case .connecting: "Connecting…"
        case .unreachable: "Can’t reach the Mac"
        }
    }

    private var notificationText: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral:
            model.remote?.push?.registered == false ? "On · connecting" : "On"
        case .denied: "Off"
        case .notDetermined: "Not set up"
        default: "—"
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
