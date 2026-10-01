import SwiftUI

/// Settings › Jarvis on Your Mac: the preferences the Mac lets a phone change (persona,
/// humour, briefing, quiet hours, interruptions, hands-free), saved on the Mac as you go.
struct MacPrefsView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<JSONValue> = .loading
    @State private var prefs: [String: JSONValue] = [:]
    @State private var saving = false

    var body: some View {
        Group {
            if let value = state.value {
                form(value)
            } else {
                LoadStateView(state: state, retry: load)
            }
        }
        .navigationTitle("Jarvis on Your Mac")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func form(_ value: JSONValue) -> some View {
        let choices = value["choices"]
        return Form {
            Section("Personality") {
                if let personas = choices?["persona"]?.arrayValue, !personas.isEmpty {
                    Picker("Persona", selection: binding("persona", "jarvis")) {
                        ForEach(personas, id: \.self) { persona in
                            Text(persona["name"]?.stringValue ?? "").tag(persona["id"]?.stringValue ?? "")
                        }
                    }
                }
                VStack(alignment: .leading) {
                    LabeledContent("Humor", value: "\(Int(number("humor", 50)))%")
                    Slider(value: Binding(get: { number("humor", 50) }, set: { prefs["humor"] = .int(Int($0)) }), in: 0...100, step: 10) { editing in
                        if !editing { save(["humor"]) }
                    }
                }
                TextField("What Jarvis calls you", text: binding("address", ""))
                    .onSubmit { save(["address"]) }
                TextField("Your name", text: binding("owner_name", ""))
                    .onSubmit { save(["owner_name"]) }
                if let languages = choices?["language"]?.arrayValue {
                    Picker("Language", selection: binding("language", "en")) {
                        ForEach(languages.compactMap(\.stringValue), id: \.self) { code in
                            Text(Locale.current.localizedString(forLanguageCode: code) ?? code).tag(code)
                        }
                    }
                }
            }

            Section {
                Toggle("Morning Briefing", isOn: flag("briefing_enabled"))
                if flag("briefing_enabled").wrappedValue {
                    DatePicker("Time", selection: time("briefing_time"), displayedComponents: .hourAndMinute)
                }
            } header: {
                Text("Briefing")
            }

            Section {
                Toggle("Speak Up with Heads-Ups", isOn: flag("proactive"))
                Toggle("Say Them Out Loud", isOn: flag("proactive_voice"))
                    .disabled(!flag("proactive").wrappedValue)
                if let options = choices?["interruptions"]?.arrayValue {
                    Picker("Interruptions", selection: binding("interruptions", "urgent")) {
                        ForEach(options.compactMap(\.stringValue), id: \.self) { option in
                            Text(option == "urgent" ? "Urgent Only" : option == "all" ? "Everything" : "Off").tag(option)
                        }
                    }
                }
                TextField("Quiet hours, e.g. 22:00-07:00", text: binding("quiet_hours", ""))
                    .onSubmit { save(["quiet_hours"]) }
            } header: {
                Text("Heads-Ups")
            } footer: {
                Text("What Jarvis on your Mac brings up by itself, and when it keeps quiet.")
            }

            Section {
                Toggle("Hands-Free on the Mac", isOn: flag("hands_free"))
                Toggle("Jarvis Voice Effect", isOn: flag("voice_effect"))
            } header: {
                Text("Listening and Voice")
            } footer: {
                Text("Hands-free turns on your Mac’s microphone so it listens for its name there.")
            }
        }
        .disabled(saving)
    }

    // MARK: - Bindings that save as they change

    private func binding(_ key: String, _ fallback: String) -> Binding<String> {
        Binding(
            get: { prefs[key]?.stringValue ?? fallback },
            set: { value in
                prefs[key] = .string(value)
                if key != "address" && key != "owner_name" && key != "quiet_hours" { save([key]) }
            }
        )
    }

    private func flag(_ key: String) -> Binding<Bool> {
        Binding(
            get: { prefs[key]?.boolValue ?? false },
            set: { value in
                prefs[key] = .bool(value)
                save([key])
            }
        )
    }

    private func number(_ key: String, _ fallback: Double) -> Double {
        prefs[key]?.doubleValue ?? fallback
    }

    /// "08:00" as a Date today, and back.
    private func time(_ key: String) -> Binding<Date> {
        Binding(
            get: {
                let parts = (prefs[key]?.stringValue ?? "08:00").split(separator: ":").compactMap { Int($0) }
                return Calendar.current.date(bySettingHour: parts.first ?? 8, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                prefs[key] = .string(String(format: "%02d:%02d", parts.hour ?? 8, parts.minute ?? 0))
                save([key])
            }
        )
    }

    // MARK: - Loading and saving

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let value = try await api.json("api/prefs")
            if case .object(let object)? = value["prefs"] { prefs = object }
            state = .loaded(value)
        } catch {
            if let problem = model.handle(error) { state = .failed(problem) }
        }
    }

    private func save(_ keys: [String]) {
        guard let api = model.pairing?.api else { return }
        var changes: [String: JSONValue] = [:]
        for key in keys { changes[key] = prefs[key] }
        Task {
            saving = true
            defer { saving = false }
            do {
                let reply = try await api.json(post: "api/prefs", ["changes": .object(changes)])
                if case .object(let saved)? = reply["prefs"] { prefs = saved }
                if let error = reply["error"]?.stringValue { model.show(error, style: .problem) }
            } catch {
                if let problem = model.handle(error) { model.show(problem.errorDescription ?? problem.title, style: .problem) }
                await load()
            }
        }
    }
}
