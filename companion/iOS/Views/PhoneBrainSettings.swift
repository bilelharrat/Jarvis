import SwiftUI

/// Settings › Jarvis on iPhone: the Claude and Gemini API keys, which one goes first, the
/// models, who answers, and what Jarvis calls you.
struct PhoneBrainSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage(BrainSettings.providerKey) private var preferred = BrainProvider.claude.rawValue
    @AppStorage(BrainProvider.claude.modelKey) private var claudeModel = BrainProvider.claude.defaultModel
    @AppStorage(BrainProvider.gemini.modelKey) private var geminiModel = BrainProvider.gemini.defaultModel
    @AppStorage("brain.address") private var address = ""
    @AppStorage(HeadsUpCenter.notifyKey) private var headsUpNotify = true
    @AppStorage(OwnerLock.key) private var ownerOnly = false
    @State private var copying = false
    @State private var copied: String?

    var body: some View {
        Section {
            KeyRow(provider: .claude)
            KeyRow(provider: .gemini)
            if model.pairing != nil {
                Button {
                    Task {
                        copying = true
                        copied = await model.copyMacKeys()
                        copying = false
                    }
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "laptopcomputer.and.arrow.down", tint: .blue)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Use My Mac’s Keys")
                                .foregroundStyle(Palette.ink)
                            Text(copied ?? "Copies the Mac’s Claude and Gemini API keys here")
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        if copying { ProgressView() }
                    }
                }
                .disabled(copying || model.isOffline)
            }
            LabeledContent {
                Text(model.hasAppleBrain ? "Ready" : "Off")
                    .foregroundStyle(model.hasAppleBrain ? Color.green : Palette.muted)
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "apple.intelligence", tint: .purple)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Apple Intelligence")
                        Text("Answers with no key, even offline")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
            Picker(selection: $preferred) {
                ForEach(BrainProvider.keyed) { provider in
                    Text(provider.title).tag(provider.rawValue)
                }
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "arrow.up.arrow.down", tint: .teal)
                    Text("Answer With")
                }
            }
            modelPicker(.claude, selection: $claudeModel)
            modelPicker(.gemini, selection: $geminiModel)
            if model.pairing != nil {
                Picker(selection: Binding(get: { model.brainMode }, set: { model.setBrainMode($0) })) {
                    ForEach(BrainMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "arrow.triangle.branch", tint: .blue)
                        Text("Who Answers")
                    }
                }
            }
            HStack(spacing: Space.s) {
                IconTile(symbol: "person.fill", tint: .orange)
                TextField("What Jarvis calls you (optional)", text: $address)
                    .submitLabel(.done)
            }
            Toggle(isOn: $headsUpNotify) {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "sparkles", tint: .yellow)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Heads-Ups When It Matters")
                        Text("When to leave, clashes about to happen")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
            Toggle(isOn: $ownerOnly) {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "faceid", tint: .green)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Only Answer When Unlocked")
                        Text("Face ID first, so only you can ask")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
        } header: {
            Text("Jarvis on iPhone")
        } footer: {
            Text(footer)
        }
    }

    private func modelPicker(_ provider: BrainProvider, selection: Binding<String>) -> some View {
        Picker(selection: selection) {
            ForEach(provider.models, id: \.id) { option in
                Text(option.name).tag(option.id)
            }
        } label: {
            HStack(spacing: Space.s) {
                IconTile(symbol: "cpu", tint: provider == .claude ? .indigo : .blue)
                Text("\(provider.title) Model")
            }
        }
    }

    private var footer: String {
        let keys = "Jarvis answers on this iPhone with your own API key: Claude (console.anthropic.com) or Gemini (aistudio.google.com). With both, the one you choose answers and the other steps in when it can’t. With neither, or when both fail, Apple Intelligence answers: Apple’s Private Cloud Compute when there’s internet, the model on this iPhone when there isn’t (it can’t see pictures and knows less). It uses your calendar, reminders, contacts, location, music, Home and Health, and the web. Keys stay in this iPhone’s Keychain and go only to Anthropic or Google."
        let more = " Heads-ups: Jarvis looks ahead at your calendar and reminders and tells you on Today; it only interrupts you (a notification) for what can't wait. Only Answer When Unlocked: Siri, Vocal Shortcuts and “Hey Jarvis” answer only once Face ID or your passcode has unlocked this iPhone (iOS doesn’t let apps recognise a voice, so this is how Jarvis knows it’s you)."
        guard model.pairing != nil else { return keys + more }
        return keys + more + " Automatic: this iPhone answers everything it can and hands what needs your Mac (files, mail, iMessage, Jarvis Code) to the Mac, opening JARVIS there if it was quit. Without a key, or when both services fail, your Mac answers. Whatever you choose, when your Mac can’t be reached (you’re away, it’s asleep or off), this iPhone answers instead of waiting for it. Use My Mac’s Keys copies the keys saved in JARVIS on your Mac, over your paired connection."
    }
}

/// One service's key: saved (with Change), or a field to paste it in.
private struct KeyRow: View {
    @Environment(AppModel.self) private var model
    let provider: BrainProvider
    @State private var key = ""
    @State private var editing = false
    @State private var problem: String?

    private var saved: Bool { model.hasPhoneKey && BrainSettings.key(for: provider) != nil }

    var body: some View {
        Group {
            if saved && !editing {
                LabeledContent {
                    Button("Change") { editing = true }
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "key.fill", tint: provider == .claude ? .gray : .blue)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(provider.title) API Key")
                            Text("Saved in this iPhone’s Keychain")
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                    }
                }
            } else {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "key.fill", tint: provider == .claude ? .gray : .blue)
                    SecureField(provider.keyPlaceholder, text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(save)
                }
                if !key.trimmed.isEmpty || saved {
                    HStack {
                        Button("Save \(provider.title) Key", action: save)
                            .disabled(key.trimmed.isEmpty)
                        if saved {
                            Spacer()
                            Button("Remove", role: .destructive) {
                                try? model.setPhoneKey(nil, for: provider)
                                editing = false
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            }
            if let problem {
                Text(problem).font(.footnote).foregroundStyle(Palette.amber)
            }
        }
    }

    private func save() {
        let value = key.trimmed
        guard !value.isEmpty else { return }
        if let reason = provider.problem(with: value) {
            problem = reason
            return
        }
        do {
            try model.setPhoneKey(value, for: provider)
            key = ""
            problem = nil
            editing = false
            Haptics.answered(negative: false)
        } catch {
            problem = "The Keychain wouldn’t keep the key: \(error.localizedDescription)"
        }
    }
}

/// How to reach Jarvis without touching the screen: "Hey Jarvis" in the app, Vocal
/// Shortcuts for anywhere (Lock Screen included), Siri via the side button, the Action
/// Button, Control Center and Back Tap.
struct HeyJarvisView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(AppModel.wakeKey) private var wakeOn = false
    @AppStorage(AppModel.wakeBackgroundKey) private var background = false
    @State private var denied = false

    var body: some View {
        GlassList {
            Section {
                step(1, "Open **Settings › Accessibility › Vocal Shortcuts** and tap **Set Up Vocal Shortcuts** (or **+**).")
                step(2, "Choose **Shortcut**, then **Jarvis** (J.A.R.V.I.S.).")
                step(3, "Say **“Jarvis”** three times when asked.")
            } header: {
                Text("Say “Jarvis” Anytime")
            } footer: {
                Text("Then just say “Jarvis”, wait for “Yes?”, and ask. iOS itself listens for the word, all the time: locked, in your pocket, with J.A.R.V.I.S. closed, even after a restart, with no extra battery. Jarvis answers out loud in its own voice without unlocking, through your Mac, or on this iPhone when the Mac can’t be reached. (Siri’s “Hey Siri, Jarvis” does the same.)")
            }

            Section {
                Toggle(isOn: Binding(get: { wakeOn }, set: { on in Task { await setWake(on) } })) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "waveform", tint: .purple)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Listen for “Hey Jarvis”")
                            Text(model.wake.isListening ? "Listening now" : "While J.A.R.V.I.S. is open")
                                .font(.footnote)
                                .foregroundStyle(model.wake.isListening ? Color.green : Palette.muted)
                        }
                    }
                }
                .disabled(!WakeWordListener.supported)
                if wakeOn {
                    Toggle(isOn: $background) {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "moon.fill", tint: .indigo)
                            Text("Keep Listening in the Background")
                        }
                    }
                }
                if denied {
                    Button("Allow the Microphone in Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            } header: {
                Text("While the App Is Open")
            } footer: {
                Text(WakeWordListener.supported
                    ? "Say “Jarvis”, or “Jarvis, what’s next?” in one go, and the conversation carries on here on screen. Recognition happens on this iPhone; nothing is recorded or sent until Jarvis hears its name. In the background it keeps going (with the orange microphone dot) until a call, Siri or another app takes the microphone, and it uses more battery."
                    : "This iPhone can’t recognise speech on-device, so “Hey Jarvis” in the app isn’t available. Use Vocal Shortcuts below instead.")
            }

            Section {
                row("button.vertical.right.press.fill", .blue, "Side Button", "Hold it and say “Jarvis” (or “Ask Jarvis what’s next”). Siri hands it straight to Jarvis.")
                row("button.horizontal.top.press.fill", .orange, "Action Button", "Settings › Action Button › Controls › Talk to Jarvis. One press and Jarvis is listening.")
                row("switch.2", .gray, "Control Center & Lock Screen", "Add the Talk to Jarvis control from the controls gallery.")
                row("hand.tap.fill", .green, "Back Tap", "Settings › Accessibility › Touch › Back Tap › Double Tap › Talk to Jarvis.")
            } header: {
                Text("Buttons")
            } footer: {
                Text("Apple keeps the side button for Siri in most countries, so holding it and saying “Jarvis” is the closest to a Jarvis button there; the Action Button can open Jarvis directly.")
            }
        }
        .navigationTitle("“Jarvis”")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func setWake(_ on: Bool) async {
        if on {
            guard await WakeWordListener.authorize() else {
                denied = true
                wakeOn = false
                return
            }
        }
        denied = false
        wakeOn = on
        model.setWakeWord(on)
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
            Text(text)
        }
    }

    private func row(_ symbol: String, _ tint: Color, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            IconTile(symbol: symbol, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(.vertical, 2)
    }
}
