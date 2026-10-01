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
    private var store: ChatStore { .shared }

    var body: some View {
        let found = store.search(query)
        GlassList {
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
                Text(Self.preview(chat))
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
