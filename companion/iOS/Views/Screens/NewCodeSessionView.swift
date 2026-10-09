import PhotosUI
import SwiftUI

/// A new Eden Code session, started from the iPhone as the Mac's composer starts one: the
/// project, what to do, and how (model, permission mode, effort, an isolated copy), with
/// pictures if they help.
struct NewCodeSessionView: View {
    let onStarted: (Int) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var options: CodeOptions?
    @State private var failure: String?
    @State private var project = ""
    @State private var prompt = ""
    @State private var modelRef = ""
    @State private var mode = "ask"
    @State private var effort = ""
    @State private var isolated = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var attachments: [CodeAttachment] = []
    @State private var starting = false
    @FocusState private var writing: Bool

    var body: some View {
        Form {
            if let options {
                Section("Project") {
                    if options.projects.isEmpty {
                        Text("No projects yet. Add one on your Mac in Settings › Projects.")
                            .foregroundStyle(Palette.muted)
                    } else {
                        Picker("Project", selection: $project) {
                            ForEach(options.projects) { item in
                                Text(item.branch.isEmpty ? item.name : "\(item.name) · \(item.branch)").tag(item.name)
                            }
                        }
                    }
                }
                Section {
                    TextField("What should it do?", text: $prompt, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($writing)
                    PhotosPicker(selection: $picked, maxSelectionCount: 6, matching: .images) {
                        Label(attachments.isEmpty ? "Add Screenshots or Photos" : "\(attachments.count) attached", systemImage: "photo.on.rectangle")
                    }
                } header: {
                    Text("Task")
                }
                Section {
                    Picker("Model", selection: $modelRef) {
                        Text("Default").tag("")
                        ForEach(options.models) { Text($0.name).tag($0.id) }
                    }
                    Picker("Permissions", selection: $mode) {
                        ForEach(options.modes) { Text($0.name).tag($0.id) }
                    }
                    Picker("Effort", selection: $effort) {
                        Text("Default").tag("")
                        ForEach(options.efforts, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    Toggle("Isolated Copy", isOn: $isolated)
                } header: {
                    Text("How")
                } footer: {
                    Text(footer)
                }
            } else if let failure {
                ErrorCallout(title: "Couldn’t reach your Mac", message: failure)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("New Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await start() }
                } label: {
                    if starting { ProgressView() } else { Text("Start") }
                }
                .disabled(!canStart)
            }
        }
        .task { await load() }
        .onChange(of: picked) { _, items in
            Task { await attach(items) }
        }
    }

    private var canStart: Bool { !starting && !project.isEmpty && !prompt.trimmed.isEmpty }

    private var footer: String {
        switch mode {
        case "plan": "Plan: it reads and proposes a plan first; nothing changes until you say so."
        case "ask": "Manual: it asks before each edit and command, here or on your Mac."
        case "edits": "Accept edits: file changes go ahead; commands still ask."
        case "smart": "Auto: Claude Code lets safe actions through and asks about the rest."
        case "auto": "Bypass permissions: it runs everything without asking. Face ID confirms it’s you."
        default: ""
        }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let found = try await api.codeOptions()
            options = found
            if project.isEmpty { project = found.projects.first?.name ?? "" }
            modelRef = found.defaultModel
            mode = found.modes.contains { $0.id == found.defaultMode } ? found.defaultMode : "ask"
            effort = found.efforts.contains(found.defaultEffort) ? found.defaultEffort : ""
            writing = true
        } catch {
            failure = model.handle(error)?.message ?? error.localizedDescription
        }
    }

    private func attach(_ items: [PhotosPickerItem]) async {
        var found: [CodeAttachment] = []
        for image in await Attachment.load(items) {
            guard let jpeg = PhotoPrep.jpeg(from: image, longest: 1568, maxBytes: 4 * 1024 * 1024) else { continue }
            found.append(CodeAttachment(name: "screenshot-\(found.count + 1).jpg", mediaType: "image/jpeg", data: jpeg))
        }
        attachments = found
    }

    private func start() async {
        guard canStart, let api = model.pairing?.api else { return }
        if CodeOptions.needsOwner(mode: mode), !(await OwnerCheck.confirm("Start a session that runs everything without asking")) {
            return
        }
        starting = true
        defer { starting = false }
        do {
            let id = try await api.codeNew(prompt: prompt.trimmed, project: project, model: modelRef, mode: mode,
                                           effort: effort, isolated: isolated, attachments: attachments)
            Haptics.answered(negative: false)
            dismiss()
            onStarted(id)
        } catch {
            Haptics.failure()
            model.show(model.handle(error)?.message ?? error.localizedDescription, style: .problem)
        }
    }
}
