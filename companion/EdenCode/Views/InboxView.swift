import SwiftUI

/// Needs attention: every card that waits on the owner in Eden Code, newest last, each
/// opening the approval sheet; sessions that need the owner without a card.
struct InboxView: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Inbox").font(.system(size: 34, weight: .bold)).tracking(-0.68).foregroundStyle(EdenTheme.ink)
                    .padding(.top, 12).padding(.horizontal, 4)
                    .accessibilityAddTraits(.isHeader)
                if store.home.attention.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle").font(.system(size: 30)).foregroundStyle(EdenTheme.green)
                        Text("Nothing waits on you").font(.headline).foregroundStyle(EdenTheme.ink)
                        Text("Approvals and questions from your sessions show up here, and as notifications.")
                            .font(.subheadline).foregroundStyle(EdenTheme.muted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(24).edenCard(radius: 20)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(store.home.attention.enumerated()), id: \.element.id) { index, card in
                            Button { store.sheetCard = card } label: { CardRow(card: card, session: session(card)) }
                                .buttonStyle(.plain)
                            if index < store.home.attention.count - 1 { Divider().overlay(EdenTheme.divider).padding(.leading, 60) }
                        }
                    }
                    .edenCard()
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(EdenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await store.refreshHome() }
    }

    private func session(_ card: PhoneCard) -> PhoneSummary? {
        store.home.sessions.first { $0.id == card.taskID }
    }

    /// "An approval and a question", "2 approvals".
    static func summary(_ cards: [PhoneCard]) -> String {
        let questions = cards.filter(\.approval.isQuestion).count
        let approvals = cards.count - questions
        func n(_ count: Int, _ word: String) -> String {
            count == 1 ? "\(word.first.map { "aeiou".contains($0) } == true ? "An" : "A") \(word)" : "\(count) \(word)s"
        }
        switch (approvals, questions) {
        case (0, 0): return "A session is waiting on you"
        case (_, 0): return n(approvals, "approval")
        case (0, _): return n(questions, "question")
        default: return "\(n(approvals, "approval")) and \(n(questions, "question").lowercased())"
        }
    }
}

struct CardRow: View {
    var card: PhoneCard
    var session: PhoneSummary?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: card.approval.isQuestion ? "questionmark.bubble.fill" : card.faceID ? "exclamationmark.triangle.fill" : "hand.raised.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(card.approval.isQuestion ? EdenTheme.accent : EdenTheme.orange, in: .rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 1) {
                Text(card.approval.question).font(.system(size: 15, weight: .medium)).foregroundStyle(EdenTheme.ink).lineLimit(2)
                Text([session?.title, session?.project, card.macOnly ? "Answer on your Mac" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 13)).foregroundStyle(EdenTheme.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.chevron)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(.rect)
    }
}
