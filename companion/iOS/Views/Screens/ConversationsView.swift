import SwiftUI

/// Conversations Jarvis holds for you (delegations): who with, the goal, where it stands.
/// One still going can be stopped, after a confirmation.
struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[DelegationItem]> = .loading
    @State private var busy: Set<String> = []

    var body: some View {
        Group {
            if let items = state.value {
                if items.isEmpty {
                    ContentUnavailableView {
                        Label("No conversations", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("When you ask Jarvis to talk to someone for you, like booking a table or finding a time, it shows up here.")
                    }
                } else {
                    list(items)
                }
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Conversations for you")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(15))
            }
        }
        .refreshable { await load() }
    }

    private func list(_ items: [DelegationItem]) -> some View {
        let open = items.filter(\.isOpen)
        let closed = items.filter { !$0.isOpen }
        return List {
            if !open.isEmpty {
                Section {
                    ForEach(open) { row($0) }
                } header: {
                    ListHeader("Going on")
                } footer: {
                    ListFooter("Jarvis says only what you allowed, and asks you before anything else.")
                }
                .glassRow()
            }
            if !closed.isEmpty {
                Section {
                    ForEach(closed) { row($0) }
                } header: {
                    ListHeader("Earlier")
                }
                .glassRow()
            }
        }
        .glassList()
    }

    private func row(_ item: DelegationItem) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            IconTile(symbol: item.needsOwner ? "hand.raised.fill" : "bubble.left.and.bubble.right.fill",
                     tint: item.needsOwner ? Palette.champagne : Palette.ink)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.xs) {
                    Text(item.with)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: Space.xxs)
                    StatusPill(text: item.statusLabel, tint: tint(for: item))
                }
                if !item.goal.isEmpty {
                    Text(item.goal)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(3)
                }
                Text(meta(for: item))
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                if item.isOpen {
                    StopConversationButton(item: item, busy: busy.contains(item.id)) {
                        Task { await stop(item) }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, Space.xxs)
    }

    private func meta(for item: DelegationItem) -> String {
        let messages = item.messages == 1 ? "1 message" : "\(item.messages) messages"
        guard let updated = item.updatedAt else { return messages }
        return "\(messages) · \(updated.ago)"
    }

    private func tint(for item: DelegationItem) -> Color {
        switch item.status {
        case "active": Palette.cyan
        case "waiting_owner": Palette.champagne
        case "done": Palette.online
        default: Palette.muted
        }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            state = .loaded(try await api.delegations().sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) })
        } catch is CancellationError {
        } catch {
            guard model.handle(error) != nil else { return }
            if state.value == nil { state = .from(error) }
        }
    }

    private func stop(_ item: DelegationItem) async {
        guard let api = model.pairing?.api else { return }
        busy.insert(item.id)
        defer { busy.remove(item.id) }
        do {
            if try await api.stopDelegation(id: item.id) {
                Haptics.answered(negative: true)
                model.show("Stopped the conversation with \(item.with).", style: .success)
            } else {
                model.show("That conversation had already ended.")
            }
            await load()
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }
}

/// Stop, with its own confirmation beside it.
private struct StopConversationButton: View {
    let item: DelegationItem
    let busy: Bool
    let onStop: () -> Void
    @State private var confirming = false

    var body: some View {
        Button {
            confirming = true
        } label: {
            if busy {
                ProgressView().controlSize(.small)
            } else {
                InlineLabel("Stop", systemImage: "stop.circle.fill")
            }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Palette.danger)
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Stop the conversation with \(item.with)")
        .confirmationDialog("Stop the conversation with \(item.with)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Stop", role: .destructive, action: onStop)
        } message: {
            Text("Jarvis stops replying for you and sends nothing more.")
        }
    }
}
