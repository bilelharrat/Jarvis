import SwiftUI

/// Settings › Jarvis on iPhone: the Claude API key, the model, who answers, and what Jarvis
/// calls you.
struct PhoneBrainSettings: View {
    @Environment(AppModel.self) private var model
    @State private var key = ""
    @State private var editingKey = false
    @State private var keyError: String?
    @AppStorage(BrainSettings.modelKey) private var chosenModel = ClaudeClient.defaultModel
    @AppStorage("brain.address") private var address = ""

    var body: some View {
        Section {
            if model.hasPhoneKey && !editingKey {
                LabeledContent {
                    Button("Change") { editingKey = true }
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "key.fill", tint: .gray)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Claude API Key")
                            Text("Saved in this iPhone’s Keychain")
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                    }
                }
            } else {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "key.fill", tint: .gray)
                    SecureField("Claude API key (sk-ant-…)", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(save)
                }
                HStack {
                    Button("Save Key", action: save)
                        .disabled(key.trimmed.isEmpty)
                    if model.hasPhoneKey {
                        Spacer()
                        Button("Remove", role: .destructive) {
                            try? model.setPhoneKey(nil)
                            editingKey = false
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
            if let keyError {
                Text(keyError).font(.footnote).foregroundStyle(Palette.amber)
            }
            Picker(selection: $chosenModel) {
                ForEach(BrainSettings.models, id: \.id) { option in
                    Text(option.name).tag(option.id)
                }
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "cpu", tint: .indigo)
                    Text("Model")
                }
            }
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
        } header: {
            Text("Jarvis on iPhone")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        let key = "Jarvis answers on this iPhone with your own Claude API key (console.anthropic.com), using your calendar, reminders, contacts, location, music, Home and Health, and the web. The key stays in this iPhone’s Keychain and goes only to Anthropic."
        guard model.pairing != nil else { return key }
        return key + " Automatic: your Mac answers whenever it can be reached, and this iPhone when it can’t."
    }

    private func save() {
        let value = key.trimmed
        guard !value.isEmpty else { return }
        guard value.hasPrefix("sk-ant-") else {
            keyError = "That doesn’t look like a Claude API key (they start with sk-ant-)."
            return
        }
        do {
            try model.setPhoneKey(value)
            key = ""
            keyError = nil
            editingKey = false
            Haptics.answered(negative: false)
        } catch {
            keyError = "The Keychain wouldn’t keep the key: \(error.localizedDescription)"
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
