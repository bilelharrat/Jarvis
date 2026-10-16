import SwiftUI

/// A card that waits on the owner, inside its session (G4, GAsk.dc.html): a glass card where
/// the input bar was, with the question, why it asks, the command, Not now and Allow (Face ID
/// first for a command or an "always", as the Mac asks Touch ID), and "Reply instead" (the
/// input bar comes back; what the owner writes goes back as the card's no, with those words).
/// A Mac-only card takes only its no here. A Claude question shows its options.
struct AskCard: View {
    let card: PhoneCard
    /// "Reply instead"; nil where there's no input bar to reply in.
    var onReply: (() -> Void)?
    var onAnswered: () -> Void = {}
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.colorScheme) private var scheme
    @State private var working = false
    @State private var problem: String?

    private var standing: [ApprovalChoice] { card.yesChoices.filter(card.isStanding) }
    private var yes: ApprovalChoice? { card.yesChoices.first { !card.isStanding($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(card.approval.question)
                .font(.eden(size: 17, weight: .semibold))
                .foregroundStyle(EdenTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(Self.why(card))
                .font(.eden(size: 14))
                .lineSpacing(3.5)
                .foregroundStyle(EdenTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if !card.approval.detail.isEmpty {
                command
                    .lineLimit(6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gGlass(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .textSelection(.enabled)
                    .accessibilityLabel("Command: \(card.approval.detail)")
            }
            if let problem {
                Text(problem).font(.eden(size: 13)).foregroundStyle(EdenTheme.failInk)
            }
            if card.approval.isQuestion && !card.macOnly {
                options
            } else {
                buttons
            }
            links
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .gGlass(RoundedRectangle(cornerRadius: 30, style: .continuous), white: 0.55, shadowRadius: 20, shadowY: 16, shadowOpacity: 0.2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Eden Code asks")
    }

    private var command: some View {
        Text(card.approval.detail.hasPrefix("$ ") ? String(card.approval.detail.dropFirst(2)) : card.approval.detail)
            .font(.eden(size: 12, design: .monospaced))
            // SF Mono sets a touch wider than the mockup's; a hair of tracking keeps a usual
            // command on one line, as drawn.
            .tracking(-0.25)
            .foregroundStyle(EdenTheme.ink2)
    }

    /// Why it asks, in a line.
    static func why(_ card: PhoneCard) -> String {
        if card.macOnly { return "This one needs Touch ID on your Mac. You can say no here; to allow it, answer on your Mac." }
        if card.approval.isQuestion { return "Pick one, or reply in your own words." }
        if card.faceID { return "It runs this on your Mac. Face ID makes sure it’s you first." }
        return "The session waits for your answer."
    }

    /// The no's words: "Not now" for an approval's plain deny, the Mac's own otherwise (a
    /// question's "Skip").
    static func noLabel(_ card: PhoneCard) -> String {
        let no = card.noChoice
        if card.approval.isQuestion { return no.label }
        return ["deny", "no", "reject"].contains(no.id.lowercased()) || ["deny", "no"].contains(no.label.lowercased()) ? "Not now" : no.label
    }

    private var buttons: some View {
        TwoButtons(ratio: 1.3, spacing: 8) {
            Button { answer(card.noChoice) } label: {
                Text(Self.noLabel(card))
                    .font(.eden(size: 16, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(EdenTheme.fill, in: .capsule)
                    .contentShape(.capsule)
            }
            .buttonStyle(PressScale(scale: 0.97))
        } second: {
            if card.macOnly {
                Label("Answer on your Mac", systemImage: "desktopcomputer")
                    .font(.eden(size: 14, weight: .semibold)).foregroundStyle(EdenTheme.muted)
                    .frame(maxWidth: .infinity, minHeight: 50)
            } else if let yes {
                Button { answer(yes) } label: {
                    HStack(spacing: 7) {
                        if card.needsFaceID(yes) { Image(systemName: "faceid").font(.eden(size: 16, weight: .medium)) }
                        Text(yes.label).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .font(.eden(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(EdenTheme.accent, in: .capsule)
                    .contentShape(.capsule)
                }
                .buttonStyle(PressScale(scale: 0.97))
                .accessibilityLabel(card.needsFaceID(yes) ? "\(yes.label), with Face ID" : yes.label)
            }
        }
        .disabled(working)
    }

    private var options: some View {
        VStack(spacing: 8) {
            ForEach(card.yesChoices) { choice in
                Button { answer(choice) } label: {
                    Text(choice.label)
                        .font(.eden(size: 16, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(EdenTheme.fill, in: .capsule)
                        .contentShape(.capsule)
                }
                .buttonStyle(PressScale(scale: 0.97))
            }
        }
        .disabled(working)
    }

    /// "Reply instead"; a question's skip; the always-allow answers.
    @ViewBuilder private var links: some View {
        let skip = card.approval.isQuestion && !card.macOnly
        if onReply != nil || skip || (!standing.isEmpty && !card.macOnly) {
            HStack(spacing: 22) {
                if skip {
                    Button(Self.noLabel(card)) { answer(card.noChoice) }
                }
                if let onReply {
                    Button("Reply instead", action: onReply)
                }
                if !standing.isEmpty && !card.macOnly {
                    Menu("Always…") {
                        ForEach(standing) { choice in
                            Button(choice.label) { answer(choice) }
                        }
                    }
                }
            }
            .font(.eden(size: 15))
            .foregroundStyle(EdenTheme.accent)
            .frame(maxWidth: .infinity)
            .disabled(working)
        }
    }

    private func answer(_ choice: ApprovalChoice) {
        working = true
        problem = nil
        Task {
            let ok = await store.answer(card, choice)
            working = false
            if ok {
                onAnswered()
                if store.sheetCard?.id == card.id { store.sheetCard = nil }
            } else if !card.needsFaceID(choice) {
                problem = "Your Mac didn’t take that answer. The card may have gone."
            }
        }
    }
}

/// Two buttons side by side, the second `ratio` times as wide (the mockups' 1 : 1.4).
struct TwoButtons<First: View, Second: View>: View {
    var ratio: CGFloat
    var spacing: CGFloat = 10
    @ViewBuilder var first: First
    @ViewBuilder var second: Second

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width - spacing
            HStack(spacing: spacing) {
                first.frame(width: width / (1 + ratio))
                second.frame(width: width * ratio / (1 + ratio))
            }
        }
        .frame(height: 50)
    }
}

/// A card with no session to show it in (G4's card on its own): a dimmed backdrop (a tap
/// closes it) and the card rising from the bottom.
struct ApprovalOverlay: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        ZStack(alignment: .bottom) {
            if let card = store.sheetCard {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { store.sheetCard = nil }
                    .accessibilityLabel("Close")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                AskCard(card: card)
                    .id(card.id)
                    .padding(.horizontal, 12)
                    .padding(.bottom, -4)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .simultaneousGesture(DragGesture().onEnded { if $0.translation.height > 80 { store.sheetCard = nil } })
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: store.sheetCard?.id)
        .onChange(of: store.sheetCard?.id) { _, id in
            // (the composer's keyboard goes down: the card's buttons are where it was)
            if id != nil { Keyboard.dismiss() }
        }
    }
}
