import SwiftUI

/// Jarvis Code sessions on the Mac: the ones that need you first, then those working, then
/// the rest. Refreshes while it's on screen.
struct CodeSessionsView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[CodeSession]> = .loading
    @State private var showNew = false
    @State private var renaming: CodeSession?
    @State private var newTitle = ""
    @State private var closing: CodeSession?

    var body: some View {
        Group {
            if let sessions = state.value {
                if sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No sessions", systemImage: "chevron.left.forwardslash.chevron.right")
                    } description: {
                        Text("Start a Jarvis Code session here or on your Mac, then follow it, answer it and ship it from anywhere.")
                    } actions: {
                        Button("New Session") { showNew = true }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                } else {
                    list(sessions)
                }
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Jarvis Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showNew = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showNew) {
            NavigationStack {
                NewCodeSessionView { id in model.destination = .codeSession(id) }
            }
        }
        .alert("Rename Session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") {
                if let session = renaming { act("rename", session, ["title": .string(newTitle)]) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Close this session?", isPresented: Binding(get: { closing != nil }, set: { if !$0 { closing = nil } }), titleVisibility: .visible) {
            Button("Close Session", role: .destructive) {
                if let session = closing { act("close", session) }
                closing = nil
            }
        } message: {
            Text("It stops and closes on your Mac. Its transcript stays, so it can be picked up again there.")
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .refreshable { await load() }
    }

    private func list(_ sessions: [CodeSession]) -> some View {
        let needsYou = sessions.filter { $0.status == .needsYou }
        let working = sessions.filter { $0.status == .working }
        let rest = sessions.filter { !$0.status.isLive }
        return GlassList {
            section("Needs you", needsYou)
            section("Working", working)
            section("Earlier", rest)
        }
        .glassList()
    }

    @ViewBuilder
    private func section(_ title: String, _ sessions: [CodeSession]) -> some View {
        if !sessions.isEmpty {
            Section {
                ForEach(sessions) { session in
                    NavigationLink(value: Destination.codeSession(session.id)) {
                        CodeSessionRow(session: session)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Close", systemImage: "xmark.circle", role: .destructive) { closing = session }
                        Button("Archive", systemImage: "archivebox") { act("meta", session, ["archived": .bool(true)]) }
                            .tint(.indigo)
                    }
                    .swipeActions(edge: .leading) {
                        Button("Pin", systemImage: "pin") { act("meta", session, ["pinned": .bool(true)]) }
                            .tint(.orange)
                    }
                    .contextMenu {
                        Button("Rename", systemImage: "pencil") {
                            newTitle = session.title
                            renaming = session
                        }
                        Button("Pin", systemImage: "pin") { act("meta", session, ["pinned": .bool(true)]) }
                        Button("Archive", systemImage: "archivebox") { act("meta", session, ["archived": .bool(true)]) }
                        Button("Close Session", systemImage: "xmark.circle", role: .destructive) { closing = session }
                    }
                }
            } header: {
                ListHeader(title)
            }
            .glassRow()
        }
    }

    /// A session action on the Mac, then the list again.
    private func act(_ action: String, _ session: CodeSession, _ fields: [String: JSONValue] = [:]) {
        Task {
            guard let api = model.pairing?.api else { return }
            do {
                let result = try await api.codeAction(action, session: session.id, fields)
                Haptics.tap()
                if !result.said.isEmpty { model.show(result.said, style: result.ok ? .success : .problem) }
                await load()
            } catch {
                if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            }
        }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let sessions = try await api.codeSessions()
            state = .loaded(sessions.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) })
        } catch is CancellationError {
        } catch {
            if model.handle(error) == nil { return }
            if state.value == nil { state = .from(error) }  // keep showing what we had
        }
    }
}

private struct CodeSessionRow: View {
    let session: CodeSession

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Image(systemName: session.status.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.body.weight(.semibold))
                .foregroundStyle(session.status.tint)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(session.status.tint.opacity(0.12)))
                .symbolEffect(.pulse, options: .repeating, isActive: session.status == .working)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text([session.project, session.branch].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.footnote.monospaced())
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                if let waiting = session.waiting {
                    InlineLabel(waiting.question, systemImage: "hand.raised.fill")
                        .font(.footnote)
                        .foregroundStyle(Palette.champagne)
                        .lineLimit(2)
                        .padding(.top, 1)
                }
            }
            Spacer(minLength: Space.xs)
            VStack(alignment: .trailing, spacing: 4) {
                Text(session.status.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(session.status.tint)
                if let updated = session.updatedAt {
                    Text(updated.ago)
                        .font(.caption2)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
        .padding(.vertical, Space.xxs)
        .accessibilityElement(children: .combine)
    }
}
