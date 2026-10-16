import SwiftUI

/// A card to answer (PhoneApprove mockup): a dark glass sheet with the risk icon, the
/// question and where it's from, the command, Deny and Allow (with Face ID for a command or
/// an "always", as the Mac asks Touch ID), and the always-allow link. A Mac-only card takes
/// only its no here. A Claude question shows its options.
struct ApprovalSheet: View {
    let card: PhoneCard
    @Environment(EdenCodeStore.self) private var store
    private func dismiss() { store.sheetCard = nil }
    @State private var working = false
    @State private var instead = ""
    @State private var problem: String?

    private var session: PhoneSummary? { store.home.sessions.first { $0.id == card.taskID } }
    private var standing: [ApprovalChoice] { card.yesChoices.filter(card.isStanding) }
    private var yes: ApprovalChoice? { card.yesChoices.first { !card.isStanding($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Capsule().fill(.white.opacity(0.3)).frame(width: 40, height: 5).frame(maxWidth: .infinity)
                .accessibilityHidden(true)
            HStack(spacing: 12) {
                Image(systemName: card.approval.isQuestion ? "questionmark" : "exclamationmark.triangle")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(card.approval.isQuestion ? Color(UIColor(hex: 0x0A84FF)) : Color(UIColor(hex: 0xFF9500)), in: .rect(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.approval.question).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    Text([session?.title, session?.project].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 13)).foregroundStyle(Color(UIColor(hex: 0xC7C7CC))).lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            if !card.approval.detail.isEmpty {
                Text(card.approval.detail.hasPrefix("$ ") ? String(card.approval.detail.dropFirst(2)) : card.approval.detail)
                    .font(.system(size: 13, design: .monospaced))
                    .lineSpacing(4)
                    .foregroundStyle(Color(UIColor(hex: 0xE5E5EA)))
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.black.opacity(0.35), in: .rect(cornerRadius: 16))
                    .textSelection(.enabled)
                    .lineLimit(8)
            }
            Text(explanation).font(.system(size: 13)).lineSpacing(3).foregroundStyle(Color(UIColor(hex: 0xD1D1D6)))
            if let problem { Text(problem).font(.system(size: 13)).foregroundStyle(Color(UIColor(hex: 0xFF6961))) }
            if card.approval.isQuestion && !card.macOnly {
                question
            } else {
                buttons
            }
            if !card.macOnly {
                TextField("", text: $instead, prompt: Text("Or tell it what to do instead").foregroundStyle(.white.opacity(0.45)))
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(.white.opacity(0.08), in: .capsule)
                    .submitLabel(.send)
                    .onSubmit { answer(card.noChoice, feedback: instead) }
            }
            ForEach(standing) { choice in
                Button { answer(choice) } label: {
                    Text(choice.label).font(.system(size: 14)).foregroundStyle(Color(UIColor(hex: 0x8FC7FF)))
                }
                .frame(maxWidth: .infinity)
                .disabled(working || card.macOnly)
            }
        }
        .padding(EdgeInsets(top: 12, leading: 20, bottom: 20, trailing: 20))
        .background {
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(Color(UIColor(hex: 0x282A38, alpha: 0.62)))
                .glassEffect(.regular.tint(Color(UIColor(hex: 0x282A38, alpha: 0.4))), in: .rect(cornerRadius: 34))
                .overlay(RoundedRectangle(cornerRadius: 34, style: .continuous).strokeBorder(.white.opacity(0.22), lineWidth: 1))
                .shadow(color: .black.opacity(0.5), radius: 40, y: 30)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .environment(\.colorScheme, .dark)
    }

    private var explanation: String {
        if card.macOnly { return "This one needs Touch ID on your Mac. You can say no from here; to allow it, answer on your Mac." }
        if card.faceID { return "It runs on your Mac. Face ID makes sure it’s you before it does." }
        if card.approval.isQuestion { return "Pick one, or tell it what to do instead." }
        return "Eden Code is waiting on your answer."
    }

    private var buttons: some View {
        TwoButtons(ratio: 1.4) {
            Button { answer(card.noChoice, feedback: instead) } label: {
                Text(card.noChoice.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(.white.opacity(0.16), in: .capsule)
                    .overlay(Capsule().strokeBorder(.white.opacity(0.24), lineWidth: 1))
            }
            .buttonStyle(PressScale(scale: 0.97))
        } second: {
            if card.macOnly {
                Label("Answer on your Mac", systemImage: "desktopcomputer")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                    .frame(maxWidth: .infinity, minHeight: 50)
            } else if let yes {
                Button { answer(yes) } label: {
                    HStack(spacing: 8) {
                        if card.needsFaceID(yes) { Image(systemName: "faceid").font(.system(size: 17)) }
                        Text(card.needsFaceID(yes) ? "\(yes.label) with Face ID" : yes.label).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(UIColor(hex: 0x1D1D1F)))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(.white, in: .capsule)
                }
                .buttonStyle(PressScale(scale: 0.97))
            }
        }
        .disabled(working)
    }

    private var question: some View {
        VStack(spacing: 8) {
            ForEach(card.yesChoices) { choice in
                Button { answer(choice) } label: {
                    Text(choice.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(UIColor(hex: 0x1D1D1F)))
                        .frame(maxWidth: .infinity, minHeight: 46).background(.white, in: .capsule)
                }
                .buttonStyle(PressScale(scale: 0.97))
            }
            Button { answer(card.noChoice, feedback: instead) } label: {
                Text(card.noChoice.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 46).background(.white.opacity(0.16), in: .capsule)
            }
        }
        .disabled(working)
    }

    private func answer(_ choice: ApprovalChoice, feedback: String? = nil) {
        working = true
        Task {
            let ok = await store.answer(card, choice, feedback: feedback)
            working = false
            if ok { dismiss() } else if !card.needsFaceID(choice) { problem = "Your Mac didn’t take that answer. The card may have gone." }
        }
    }
}

/// Two buttons side by side, the second `ratio` times as wide (the mockups' 1 : 1.4).
struct TwoButtons<First: View, Second: View>: View {
    var ratio: CGFloat
    @ViewBuilder var first: First
    @ViewBuilder var second: Second

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width - 10
            HStack(spacing: 10) {
                first.frame(width: width / (1 + ratio))
                second.frame(width: width * ratio / (1 + ratio))
            }
        }
        .frame(height: 50)
    }
}

/// The approval sheet over every tab: a dimmed backdrop (a tap closes it) and the card
/// rising from the bottom, as the mockup draws it (not the system sheet, whose own glass
/// would show around it).
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
                ApprovalSheet(card: card)
                    .id(card.id)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .simultaneousGesture(DragGesture().onEnded { if $0.translation.height > 80 { store.sheetCard = nil } })
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: store.sheetCard?.id)
        .onChange(of: store.sheetCard?.id) { _, id in
            // (the composer's keyboard goes down: the card's buttons are where it was)
            if id != nil { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }
}
