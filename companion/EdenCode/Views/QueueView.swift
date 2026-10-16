import SwiftUI

/// The to-do queue (code_todo): each project's cards in the owner's order, with Start (never
/// in Auto or Bypass from here), and what's queued, running or started.
struct QueueView: View {
    @Environment(EdenCodeStore.self) private var store
    @State private var problem: String?
    @State private var starting: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Queue").font(.system(size: 34, weight: .bold)).tracking(-0.68).foregroundStyle(EdenTheme.ink)
                    .padding(.top, 12).padding(.horizontal, 4)
                    .accessibilityAddTraits(.isHeader)
                if let problem { ProblemBanner(text: problem) }
                if store.todos.cards.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "list.bullet.rectangle").font(.system(size: 30)).foregroundStyle(EdenTheme.accent)
                        Text("No to-dos").font(.headline).foregroundStyle(EdenTheme.ink)
                        Text("Write work ahead on your Mac’s agent board; it waits here to start.")
                            .font(.subheadline).foregroundStyle(EdenTheme.muted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(24).edenCard(radius: 20)
                }
                ForEach(store.todos.byProject, id: \.project) { group in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(group.project.uppercased()).font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.muted).padding(.horizontal, 6)
                        VStack(spacing: 0) {
                            ForEach(Array(group.cards.enumerated()), id: \.element.id) { index, card in
                                row(card)
                                if index < group.cards.count - 1 { Divider().overlay(EdenTheme.divider).padding(.leading, 14) }
                            }
                        }
                        .edenCard()
                    }
                }
                UsageGlance(usage: store.usage)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(EdenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await store.refreshTodos(); await store.refreshUsage() }
        .task { await store.refreshTodos() }
    }

    private func row(_ card: PhoneTodoCard) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title.isEmpty ? card.prompt : card.title).font(.system(size: 15, weight: .medium)).foregroundStyle(EdenTheme.ink).lineLimit(2)
                Text([card.stateLabel, card.mode.isEmpty ? nil : CodeModes.name(card.mode), card.model.isEmpty ? nil : store.options.modelName(card.model)]
                        .compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 13)).foregroundStyle(EdenTheme.muted)
            }
            Spacer(minLength: 8)
            if let task = card.taskID, !card.waiting {
                Button("Open") { store.open(session: task) }.buttonStyle(.glass).font(.system(size: 13, weight: .semibold))
            } else if card.waiting {
                if card.startsOnMacOnly {
                    Text("On your Mac").font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
                        .accessibilityLabel("Starts on your Mac: its mode is \(CodeModes.name(card.mode))")
                } else {
                    Button {
                        starting = card.id
                        Task {
                            problem = await store.startTodo(card)
                            starting = nil
                        }
                    } label: {
                        if starting == card.id { ProgressView() } else { Text("Start") }
                    }
                    .buttonStyle(.glassProminent)
                    .font(.system(size: 13, weight: .semibold))
                    .disabled(starting != nil)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}
