import SwiftUI

/// The Mac's past conversations, from the iPhone (the Mac's companion_chats.py): searched,
/// read, carried on there, renamed, pinned or deleted, and a new one started.
struct MacChatsList: View {
    let query: String

    @Environment(AppModel.self) private var model
    @State private var items: [MacChat]?
    @State private var renaming: MacChat?
    @State private var newTitle = ""
    @State private var deleting: MacChat?

    struct MacChat: Identifiable, Hashable {
        var id: String
        var title: String
        var preview: String
        var at: Date?
        var current: Bool
        var pinned: Bool
    }

    var body: some View {
        Group {
            if let items {
                if items.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "No Conversations" : "No Matches", systemImage: "desktopcomputer",
                                           description: Text(query.isEmpty ? "Conversations with Jarvis on your Mac show up here." : "No conversation on your Mac matches “\(query)”."))
                } else {
                    Section(query.isEmpty ? "On Your Mac" : "Matches on Your Mac") {
                        ForEach(items) { chat in
                            NavigationLink {
                                MacChatView(chat: chat)
                            } label: {
                                row(chat)
                            }
                            .swipeActions(edge: .leading) {
                                Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin") {
                                    manage(chat, "pin", ["pinned": .bool(!chat.pinned)])
                                }
                                .tint(.orange)
                            }
                            .swipeActions(edge: .trailing) {
                                if !chat.current {
                                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = chat }
                                }
                                Button("Rename", systemImage: "pencil") {
                                    newTitle = chat.title
                                    renaming = chat
                                }
                                .tint(.blue)
                            }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task(id: query) { await load() }
        .alert("Rename Conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") {
                if let chat = renaming { manage(chat, "rename", ["title": .string(newTitle)]) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete this conversation on your Mac for good?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let chat = deleting { manage(chat, "delete") }
                deleting = nil
            }
        }
    }

    private func row(_ chat: MacChat) -> some View {
        HStack(spacing: Space.s) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if chat.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                    Text(chat.title.isEmpty ? "…" : chat.title).lineLimit(1)
                    if chat.current { Text("Now").font(.caption2.weight(.semibold)).foregroundStyle(Palette.cyan) }
                }
                if !chat.preview.isEmpty, chat.preview != chat.title {
                    Text(chat.preview).font(.footnote).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            Spacer(minLength: Space.xs)
            if let at = chat.at {
                Text(at.formatted(.relative(presentation: .named))).font(.caption2).foregroundStyle(Palette.muted)
            }
        }
    }

    private func load() async {
        guard let api = model.pairing?.api else { items = []; return }
        let query = [URLQueryItem(name: "q", value: self.query)]
        do {
            let data = try await api.request("api/chats", query: query, timeout: 20)
            let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:]
            items = (json["items"]?.arrayValue ?? []).compactMap { item in
                guard let id = item["session_id"]?.stringValue else { return nil }
                let ms = item["at"]?.intValue ?? 0
                return MacChat(id: id, title: item["title"]?.stringValue ?? "", preview: item["preview"]?.stringValue ?? "",
                               at: ms > 0 ? Date(timeIntervalSince1970: Double(ms) / 1000) : nil,
                               current: item["current"]?.boolValue ?? false, pinned: item["pinned"]?.boolValue ?? false)
            }
        } catch {
            items = []
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    private func manage(_ chat: MacChat, _ action: String, _ fields: [String: JSONValue] = [:]) {
        Task {
            guard let api = model.pairing?.api else { return }
            var body = fields
            body["session_id"] = .string(chat.id)
            body["action"] = .string(action)
            do {
                _ = try await api.request("api/chats/manage", body: try JSONValue.object(body).encoded(), timeout: 30)
                Haptics.tap()
                await load()
            } catch {
                if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            }
        }
    }
}

/// One of the Mac's conversations, read on the iPhone, with Carry On (it becomes the Mac's
/// current conversation, after the Mac's card, which shows up here to answer).
struct MacChatView: View {
    let chat: MacChatsList.MacChat

    @Environment(AppModel.self) private var model
    @State private var lines: [TranscriptLine]?
    @State private var problem: String?

    var body: some View {
        Group {
            if let lines {
                TranscriptView(lines: lines, onAction: { action, line in model.act(action, on: line) })
            } else if let problem {
                ContentUnavailableView("Can’t Read It", systemImage: "exclamationmark.bubble", description: Text(problem))
            } else {
                ProgressView()
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle(chat.title.isEmpty ? "Conversation" : chat.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !chat.current {
                ToolbarItem(placement: .primaryAction) {
                    Button("Carry On") { Task { await carryOn() } }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let data = try await api.request("api/chats/one", query: [URLQueryItem(name: "id", value: chat.id)], timeout: 20)
            let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:]
            if json["error"]?.stringValue == "unreadable" {
                problem = "This conversation’s record can’t be read on your Mac."
                return
            }
            lines = (json["entries"]?.arrayValue ?? []).enumerated().map { index, entry in
                TranscriptLine(id: "mac:\(chat.id):\(index)", kind: entry["role"]?.stringValue == "user" ? .user : .jarvis,
                               text: entry["text"]?.stringValue ?? "")
            }
        } catch {
            problem = model.handle(error)?.message ?? error.localizedDescription
        }
    }

    private func carryOn() async {
        guard let api = model.pairing?.api else { return }
        do {
            _ = try await api.request("api/chats/resume", body: try JSONValue.object(["session_id": .string(chat.id)]).encoded(), timeout: 20)
            model.show("Your Mac asks to carry it on: answer the card in Jarvis.")
            await model.refresh()
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }
}
