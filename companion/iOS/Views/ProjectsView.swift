import SwiftUI
import UniformTypeIdentifiers

/// The file types a project keeps (the same as a request's documents).
private let projectFileTypes: [UTType] = [.pdf, .plainText, .text, .rtf, .commaSeparatedText, .json, .html, .xml, .sourceCode]

// MARK: - This iPhone

/// Projects for Jarvis on this iPhone (ProjectStore): chats kept together, with instructions
/// and files that go with every request in them.
struct PhoneProjectsView: View {
    /// Closes the chats sheet (a chat was opened or started).
    let close: () -> Void

    @State private var naming = false
    @State private var newName = ""
    private var store: ProjectStore { .shared }

    var body: some View {
        GlassList {
            Section {
                Button {
                    newName = ""
                    naming = true
                } label: {
                    Label("New Project", systemImage: "folder.badge.plus")
                }
            } footer: {
                Text("A project keeps chats together, with instructions and files Jarvis uses in each of them.")
            }
            if !store.projects.isEmpty {
                Section("Projects") {
                    ForEach(store.projects) { project in
                        NavigationLink {
                            PhoneProjectView(id: project.id, close: close)
                        } label: {
                            ProjectRow(name: project.name, chats: ChatStore.shared.chats(in: project.id).count, files: project.files.count)
                        }
                    }
                }
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .alert("New Project", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Create") { store.create(name: newName) }
            Button("Cancel", role: .cancel) {}
        }
    }
}

struct ProjectRow: View {
    let name: String
    let chats: Int
    let files: Int
    var open = false

    var body: some View {
        HStack(spacing: Space.s) {
            Image(systemName: open ? "folder.fill" : "folder").foregroundStyle(Palette.cyan)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).lineLimit(1)
                let counts = [chats > 0 ? "\(chats) chat\(chats == 1 ? "" : "s")" : nil,
                              files > 0 ? "\(files) file\(files == 1 ? "" : "s")" : nil].compactMap { $0 }
                if !counts.isEmpty {
                    Text(counts.joined(separator: " · ")).font(.footnote).foregroundStyle(Palette.muted)
                }
            }
            if open {
                Spacer()
                Text("Open").font(.caption2.weight(.semibold)).foregroundStyle(Palette.cyan)
            }
        }
    }
}

/// One project on this iPhone: its name, instructions, files and chats.
struct PhoneProjectView: View {
    let id: UUID
    let close: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var picking = false
    @State private var deleting = false
    private var store: ProjectStore { .shared }

    var body: some View {
        GlassList {
            if let project = store.project(id) {
                Section {
                    Button {
                        save()
                        model.brain.newChat(project: id)
                        close()
                    } label: {
                        Label("New Chat in This Project", systemImage: "square.and.pencil")
                    }
                }
                Section("Name") {
                    TextField("Project name", text: $name)
                        .onSubmit(save)
                }
                Section {
                    TextEditor(text: $instructions)
                        .frame(minHeight: 110)
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("How Jarvis should answer in this project, and what to keep in mind.")
                }
                Section("Files") {
                    ForEach(project.files) { file in
                        HStack {
                            Image(systemName: "doc.text").foregroundStyle(Palette.muted)
                            Text(file.name).lineLimit(1)
                            Spacer()
                            Text(file.text.count.formatted(.number.notation(.compactName))).font(.caption2).foregroundStyle(Palette.muted)
                        }
                        .swipeActions {
                            Button("Remove", systemImage: "trash", role: .destructive) { store.removeFile(id, name: file.name) }
                        }
                    }
                    Button {
                        picking = true
                    } label: {
                        Label("Add Files", systemImage: "paperclip")
                    }
                }
                let chats = ChatStore.shared.chats(in: id)
                if !chats.isEmpty {
                    Section("Chats") {
                        ForEach(chats) { chat in
                            Button {
                                save()
                                model.brain.open(chat)
                                close()
                            } label: {
                                HStack {
                                    Text(chat.title).foregroundStyle(Palette.ink).lineLimit(1)
                                    Spacer()
                                    Text(chat.updated.formatted(.relative(presentation: .named))).font(.caption2).foregroundStyle(Palette.muted)
                                }
                            }
                            .swipeActions {
                                Button("Remove", systemImage: "folder.badge.minus") { ChatStore.shared.file(chat.id, in: nil) }
                            }
                        }
                    }
                }
                Section {
                    Button("Delete Project", role: .destructive) { deleting = true }
                }
            }
        }
        .navigationTitle(store.project(id)?.name ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            name = store.project(id)?.name ?? ""
            instructions = store.project(id)?.instructions ?? ""
        }
        .onDisappear(perform: save)
        .fileImporter(isPresented: $picking, allowedContentTypes: projectFileTypes, allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                switch PickedDocument.read(url) {
                case .success(let document):
                    guard let text = PhoneProject.text(of: document) else {
                        model.show("There’s no text in \(document.name) to keep.", style: .problem)
                        continue
                    }
                    if let problem = store.addFile(id, name: document.name, text: text) { model.show(problem, style: .problem) }
                case .failure(let why):
                    model.show(why.message, style: .problem)
                }
            }
        }
        .confirmationDialog("Delete this project and its files? Its chats stay.", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete Project", role: .destructive) {
                if model.brain.project == id { model.brain.setProject(nil) }
                store.delete(id)
                dismiss()
            }
        }
    }

    private func save() {
        guard store.project(id) != nil else { return }
        store.update(id, name: name, instructions: instructions)
    }
}

// MARK: - Your Mac

/// One of the Mac's projects, as /api/projects lists it.
struct MacProject: Identifiable, Hashable {
    struct File: Hashable { var name: String; var chars: Int }
    struct Conversation: Hashable { var id: String; var title: String }

    var id: String
    var name: String
    var instructions: String
    var files: [File]
    var conversations: [Conversation]

    static func listing(_ json: JSONValue) -> (items: [MacProject], active: String, current: String) {
        let items = (json["items"]?.arrayValue ?? []).compactMap { item -> MacProject? in
            guard let id = item["id"]?.stringValue else { return nil }
            return MacProject(
                id: id, name: item["name"]?.stringValue ?? "", instructions: item["instructions"]?.stringValue ?? "",
                files: (item["files"]?.arrayValue ?? []).compactMap { f in
                    f["name"]?.stringValue.map { File(name: $0, chars: f["chars"]?.intValue ?? 0) }
                },
                conversations: (item["conversations"]?.arrayValue ?? []).compactMap { c in
                    c["session_id"]?.stringValue.map { Conversation(id: $0, title: c["title"]?.stringValue ?? "") }
                })
        }
        return (items, json["active"]?.stringValue ?? "", json["current"]?.stringValue ?? "")
    }
}

/// The Mac's projects (companion_projects.py), shared by the list and a project's page.
@MainActor
@Observable
final class MacProjects {
    var items: [MacProject]?
    var active = ""
    var current = ""

    func take(_ data: Data) {
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:]
        let listing = MacProject.listing(json)
        items = listing.items
        active = listing.active
        current = listing.current
    }

    func load(_ model: AppModel) async {
        guard let api = model.pairing?.api else { items = []; return }
        do {
            take(try await api.request("api/projects", timeout: 20))
        } catch {
            items = items ?? []
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    /// A change; true when it went through.
    @discardableResult
    func post(_ model: AppModel, _ path: String, _ body: [String: JSONValue], timeout: TimeInterval = 30) async -> Bool {
        guard let api = model.pairing?.api else { return false }
        do {
            take(try await api.request("api/projects/\(path)", body: try JSONValue.object(body).encoded(), timeout: timeout))
            Haptics.tap()
            return true
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            return false
        }
    }
}

struct MacProjectsView: View {
    @Environment(AppModel.self) private var model
    @State private var desk = MacProjects()
    @State private var naming = false
    @State private var newName = ""

    var body: some View {
        GlassList {
            Section {
                Button {
                    newName = ""
                    naming = true
                } label: {
                    Label("New Project on Your Mac", systemImage: "folder.badge.plus")
                }
            } footer: {
                Text("While a project is open on your Mac, the conversations started there are in it, with its instructions and files.")
            }
            if let items = desk.items {
                if !items.isEmpty {
                    Section("On Your Mac") {
                        ForEach(items) { project in
                            NavigationLink {
                                MacProjectView(id: project.id, desk: desk)
                            } label: {
                                ProjectRow(name: project.name, chats: project.conversations.count, files: project.files.count,
                                           open: project.id == desk.active)
                            }
                            .swipeActions(edge: .leading) {
                                if project.id == desk.active {
                                    Button("Close", systemImage: "folder") { Task { await desk.post(model, "use", ["id": ""]) } }
                                } else {
                                    Button("Open", systemImage: "folder.fill") { Task { await desk.post(model, "use", ["id": .string(project.id)]) } }
                                        .tint(.blue)
                                }
                            }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Projects on Your Mac")
        .navigationBarTitleDisplayMode(.inline)
        .task { await desk.load(model) }
        .refreshable { await desk.load(model) }
        .alert("New Project", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Create") { Task { await desk.post(model, "save", ["name": .string(newName)]) } }
            Button("Cancel", role: .cancel) {}
        }
    }
}

struct MacProjectView: View {
    let id: String
    let desk: MacProjects

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var picking = false
    @State private var deleting = false

    private var project: MacProject? { desk.items?.first { $0.id == id } }

    var body: some View {
        GlassList {
            if let project {
                Section {
                    if project.id == desk.active {
                        Button {
                            Task { await desk.post(model, "use", ["id": ""]) }
                        } label: {
                            Label("Close the Project on Your Mac", systemImage: "folder")
                        }
                    } else {
                        Button {
                            Task {
                                if await desk.post(model, "use", ["id": .string(id)]) {
                                    model.show("“\(project.name)” is open on your Mac: new conversations there are in it.", style: .success)
                                }
                            }
                        } label: {
                            Label("Open on Your Mac", systemImage: "folder.fill")
                        }
                    }
                }
                Section("Name") {
                    TextField("Project name", text: $name)
                }
                Section {
                    TextEditor(text: $instructions).frame(minHeight: 110)
                    if name != project.name || instructions != project.instructions {
                        Button("Save") {
                            Task { await desk.post(model, "save", ["id": .string(id), "name": .string(name), "instructions": .string(instructions)]) }
                        }
                    }
                } header: {
                    Text("Instructions")
                }
                Section("Files") {
                    ForEach(project.files, id: \.name) { file in
                        HStack {
                            Image(systemName: "doc.text").foregroundStyle(Palette.muted)
                            Text(file.name).lineLimit(1)
                            Spacer()
                            Text(file.chars.formatted(.number.notation(.compactName))).font(.caption2).foregroundStyle(Palette.muted)
                        }
                        .swipeActions {
                            Button("Remove", systemImage: "trash", role: .destructive) {
                                Task { await desk.post(model, "unfile", ["id": .string(id), "name": .string(file.name)]) }
                            }
                        }
                    }
                    Button {
                        picking = true
                    } label: {
                        Label("Add Files", systemImage: "paperclip")
                    }
                }
                if !project.conversations.isEmpty {
                    Section("Conversations") {
                        ForEach(project.conversations, id: \.id) { convo in
                            NavigationLink {
                                MacChatView(chat: MacChatsList.MacChat(id: convo.id, title: convo.title, preview: "", at: nil,
                                                                       current: convo.id == desk.current, pinned: false))
                            } label: {
                                HStack {
                                    Text(convo.title.isEmpty ? "Conversation" : convo.title).lineLimit(1)
                                    if convo.id == desk.current { Text("Now").font(.caption2.weight(.semibold)).foregroundStyle(Palette.cyan) }
                                }
                            }
                            .swipeActions {
                                Button("Remove", systemImage: "folder.badge.minus") {
                                    Task { await desk.post(model, "assign", ["session_id": .string(convo.id), "id": ""]) }
                                }
                            }
                        }
                    }
                }
                if !desk.current.isEmpty, !project.conversations.contains(where: { $0.id == desk.current }) {
                    Section {
                        Button {
                            Task { await desk.post(model, "assign", ["session_id": .string(desk.current), "id": .string(id)]) }
                        } label: {
                            Label("Add the Mac’s Current Conversation", systemImage: "folder.badge.plus")
                        }
                    }
                }
                Section {
                    Button("Delete Project", role: .destructive) { deleting = true }
                }
            }
        }
        .navigationTitle(project?.name ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            name = project?.name ?? ""
            instructions = project?.instructions ?? ""
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: projectFileTypes, allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task {
                for url in urls {
                    switch PickedDocument.read(url) {
                    case .success(let document):
                        var body: [String: JSONValue] = ["id": .string(id), "name": .string(document.name)]
                        if let text = document.text { body["text"] = .string(text) } else { body["pdf"] = .string(document.data.base64EncodedString()) }
                        await desk.post(model, "file", body, timeout: 180)
                    case .failure(let why):
                        model.show(why.message, style: .problem)
                    }
                }
            }
        }
        .confirmationDialog("Delete this project and its files? Its conversations stay.", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete Project", role: .destructive) {
                Task {
                    if await desk.post(model, "delete", ["id": .string(id)]) { dismiss() }
                }
            }
        }
    }
}
