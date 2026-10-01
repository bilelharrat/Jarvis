import SwiftUI

/// Your chats with Jarvis on this iPhone, as the Claude, ChatGPT and Gemini apps keep them:
/// search, pinned ones first, swipe to pin, rename or delete, tap to pick one up again.
struct ChatsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var renaming: SavedChat?
    @State private var newTitle = ""
    @State private var confirmDeleteAll = false
    @State private var place: Place = .phone
    private var store: ChatStore { .shared }

    enum Place: Hashable { case phone, mac }

    var body: some View {
        let found = store.search(query)
        GlassList {
            if model.pairing != nil {
                Picker("Where", selection: $place) {
                    Text("This iPhone").tag(Place.phone)
                    Text("Your Mac").tag(Place.mac)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            if place == .mac {
                Section {
                    Button {
                        Task { await newOnMac() }
                    } label: {
                        Label("New Conversation on Your Mac", systemImage: "square.and.pencil")
                    }
                    NavigationLink {
                        MacProjectsView()
                    } label: {
                        Label("Projects", systemImage: "folder")
                    }
                }
                MacChatsList(query: query)
            } else {
            Section {
                Button {
                    model.brain.newChat()
                    dismiss()
                } label: {
                    Label("New Chat", systemImage: "square.and.pencil")
                }
                Button {
                    model.brain.newChat(temporary: true)
                    dismiss()
                } label: {
                    Label("Temporary Chat", systemImage: "eye.slash")
                }
                NavigationLink {
                    PhoneProjectsView(close: { dismiss() })
                } label: {
                    Label("Projects", systemImage: "folder")
                }
            } footer: {
                Text("A temporary chat isn’t kept here, and Jarvis remembers nothing from it.")
            }
            if found.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No Chats Yet" : "No Matches",
                                       systemImage: "bubble.left.and.bubble.right",
                                       description: Text(query.isEmpty ? "Chats with Jarvis on this iPhone show up here." : "Nothing said in your chats matches “\(query)”."))
            } else {
                Section(query.isEmpty ? "Chats" : "Matches") {
                    ForEach(found) { chat in
                        Button {
                            model.brain.open(chat)
                            dismiss()
                        } label: {
                            row(chat)
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .leading) {
                            Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin") {
                                store.togglePin(chat.id)
                            }
                            .tint(.orange)
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                if chat.id == model.brain.chatID { model.brain.newChat() }
                                store.delete(chat.id)
                            }
                            Button("Rename", systemImage: "pencil") {
                                newTitle = chat.title
                                renaming = chat
                            }
                            .tint(.blue)
                        }
                        .contextMenu {
                            Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin") { store.togglePin(chat.id) }
                            Button("Rename", systemImage: "pencil") {
                                newTitle = chat.title
                                renaming = chat
                            }
                            Menu {
                                ForEach(ProjectStore.shared.projects) { project in
                                    Button {
                                        move(chat, to: project.id)
                                    } label: {
                                        if chat.project == project.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                                    }
                                }
                                if chat.project != nil {
                                    Button("No Project", systemImage: "folder.badge.minus") { move(chat, to: nil) }
                                }
                            } label: {
                                Label("Move to Project", systemImage: "folder")
                            }
                            .disabled(ProjectStore.shared.projects.isEmpty)
                            ShareLink(item: Self.transcript(chat), preview: SharePreview(chat.title)) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                if chat.id == model.brain.chatID { model.brain.newChat() }
                                store.delete(chat.id)
                            }
                        }
                    }
                }
                if query.isEmpty {
                    Section {
                        Button("Delete All Chats", role: .destructive) { confirmDeleteAll = true }
                    }
                }
            }
            }
        }
        .searchable(text: $query, prompt: "Search chats")
        .navigationTitle("Chats")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .alert("Rename Chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") {
                if let chat = renaming { store.rename(chat.id, to: newTitle) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete every chat on this iPhone?", isPresented: $confirmDeleteAll, titleVisibility: .visible) {
            Button("Delete All Chats", role: .destructive) {
                store.deleteAll()
                model.brain.newChat()
            }
        }
    }

    private func move(_ chat: SavedChat, to project: UUID?) {
        if chat.id == model.brain.chatID { model.brain.setProject(project) } else { ChatStore.shared.file(chat.id, in: project) }
    }

    private func newOnMac() async {
        guard let api = model.pairing?.api else { return }
        do {
            _ = try await api.request("api/chats/new", body: Data("{}".utf8), timeout: 30)
            Haptics.answered(negative: false)
            model.show("A new conversation started on your Mac.", style: .success)
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    private func row(_ chat: SavedChat) -> some View {
        HStack(spacing: Space.s) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if chat.pinned {
                        Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange)
                    }
                    Text(chat.title)
                        .font(.body.weight(chat.id == model.brain.chatID ? .semibold : .regular))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                }
                Text([ProjectStore.shared.project(chat.project).map { "📁 \($0.name)" }, Self.preview(chat).nilIfEmpty].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.xs)
            Text(chat.updated.formatted(.relative(presentation: .named)))
                .font(.caption2)
                .foregroundStyle(Palette.muted)
        }
        .contentShape(Rectangle())
    }

    /// The last reply as plain words (no Markdown marks).
    static func preview(_ chat: SavedChat) -> String {
        guard let text = chat.lines.last(where: { $0.role == "jarvis" })?.text else { return "" }
        let lines = text.components(separatedBy: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("|") || trimmed.isEmpty { return nil }
            return String(trimmed.drop { "#>-*• ".contains($0) })
        }
        return String(TranscriptRow.markdown(lines.joined(separator: " ")).characters)
    }

    /// The chat as plain text, to share.
    static func transcript(_ chat: SavedChat) -> String {
        let lines = chat.lines.filter { $0.role != "problem" }.map { line in
            "\(line.role == "user" ? "You" : "Jarvis"): \(line.text)"
        }
        return ([chat.title, ""] + lines).joined(separator: "\n\n")
    }
}
