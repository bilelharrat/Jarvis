import SwiftUI

/// A new session in a project: what to do, the mode (Manual or Accept edits), the model, an
/// isolated copy; POST /new, then its screen opens.
struct NewSessionSheet: View {
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var project = ""
    @State private var prompt = ""
    @State private var mode = "ask"
    @State private var model = ""
    @State private var isolated = false
    @State private var starting = false
    @State private var problem: String?
    @State private var dictation = Dictation()

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    Picker("Project", selection: $project) {
                        ForEach(store.options.projects) { p in
                            Text(p.branch.isEmpty ? p.name : "\(p.name) · \(p.branch)").tag(p.name)
                        }
                    }
                    .pickerStyle(.navigationLink)
                }
                Section {
                    TextField("What should it do?", text: $prompt, axis: .vertical)
                        .lineLimit(4...10)
                    Button {
                        Task { await dictation.toggle() }
                    } label: {
                        Label(dictation.listening ? "Stop dictating" : "Dictate", systemImage: dictation.listening ? "stop.circle.fill" : "mic")
                    }
                } header: {
                    Text("Task")
                } footer: {
                    if let problem = dictation.problem { Text(problem) }
                }
                Section {
                    Picker("Mode", selection: $mode) {
                        ForEach(store.options.modes) { Text($0.name).tag($0.id) }
                    }
                    Picker("Model", selection: $model) {
                        Text("Your default").tag("")
                        ForEach(store.options.models) { m in
                            Text(m.needsKey ? "\(m.name) (needs a key on the Mac)" : m.name).tag(m.ref)
                                .selectionDisabled(m.needsKey)
                        }
                    }
                    Toggle("Work in an isolated copy", isOn: $isolated)
                } footer: {
                    Text("From your iPhone a session runs in Manual or Accept edits. Bypass permissions is set on your Mac.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(EdenTheme.failInk) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(EdenBackground())
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { start() } label: { starting ? AnyView(ProgressView()) : AnyView(Text("Start").bold()) }
                        .disabled(starting || project.isEmpty || prompt.trimmed.isEmpty)
                }
            }
            .onAppear {
                if project.isEmpty { project = store.options.projects.first?.name ?? "" }
                mode = CodeModes.phone.contains { $0.id == store.options.defaultMode } ? store.options.defaultMode : "ask"
            }
            .onChange(of: dictation.heard) { _, heard in if !heard.isEmpty { prompt = heard } }
            .task { if store.options.projects.isEmpty { await store.refreshAll() } }
        }
    }

    private func start() {
        guard let backend = store.backend else { return }
        starting = true
        dictation.stop()
        Task {
            defer { starting = false }
            do {
                let ok = try await backend.newSession(directory: project, prompt: prompt.trimmed, mode: mode, model: model.isEmpty ? nil : model, isolated: isolated)
                dismiss()
                await store.refreshHome()
                if let id = ok.id { store.open(session: id) }
            } catch {
                problem = (error as? JarvisError)?.message ?? error.localizedDescription
            }
        }
    }
}
