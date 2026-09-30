import SwiftUI

/// Jarvis Code sessions on the Mac: the ones that need you first, then those working, then
/// the rest. Refreshes while it's on screen.
struct CodeSessionsView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[CodeSession]> = .loading

    var body: some View {
        Group {
            if let sessions = state.value {
                if sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No sessions", systemImage: "chevron.left.forwardslash.chevron.right")
                    } description: {
                        Text("Jarvis Code sessions you start on your Mac show up here, to follow and answer from anywhere.")
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
        return List {
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
                }
            } header: {
                ListHeader(title)
            }
            .glassRow()
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
