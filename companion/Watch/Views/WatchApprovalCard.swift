import SwiftUI

/// An approval on the wrist: big Allow (first choice) and Deny (last choice), with any
/// other choices between them, and No, because… (a no with what to do instead).
struct WatchApprovalCard: View {
    let approval: Approval
    let onChoose: (ApprovalChoice) -> Void
    /// "No, because…": dictated or scribbled.
    var onReason: ((String) -> Void)?

    @State private var chosen: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(Palette.amber)
                HUDText("Needs your OK", color: Palette.amber)
            }
            .accessibilityHidden(true)
            Text(approval.question)
                .font(.headline)
                .foregroundStyle(Palette.ink)
            if !approval.detail.trimmed.isEmpty {
                Text(approval.detail)
                    .font(.caption2)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(expanded ? nil : 3)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.well))
                    .onTapGesture { withAnimation { expanded.toggle() } }
                    .accessibilityHint(expanded ? "" : "Tap to read all of it")
            }
            button(approval.primary, prominent: true)
            ForEach(middleChoices) { button($0, prominent: false) }
            if approval.negative != approval.primary {
                button(approval.negative, prominent: false)
            }
            if let onReason, chosen == nil {
                TextFieldLink(prompt: Text("Why not?")) {
                    Label("No, because…", systemImage: "text.bubble")
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Palette.ink2)
                } onSubmit: { reason in
                    guard !reason.trimmed.isEmpty else { return }
                    chosen = ApprovalResponse.negative(in: approval.choices)
                    onReason(reason)
                }
                .buttonStyle(.bordered)
                .accessibilityHint("Dictate or scribble why, or what to do instead")
            }
        }
        .padding(10)
        .glassCard(cornerRadius: 18, tint: Palette.champagne, strength: 0.9)
        .accessibilityElement(children: .contain)
    }

    private var middleChoices: [ApprovalChoice] {
        guard approval.choices.count > 2 else { return [] }
        return Array(approval.choices.dropFirst().dropLast())
    }

    private func button(_ choice: ApprovalChoice, prominent: Bool) -> some View {
        Button {
            guard chosen == nil else { return }
            chosen = choice.id
            onChoose(choice)
        } label: {
            HStack(spacing: 6) {
                if chosen == choice.id {
                    ProgressView().frame(width: 16, height: 16)
                }
                Text(choice.label)
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(prominent ? Color.white : (choice.isNegative ? Palette.danger : Palette.ink))
        }
        .buttonStyle(.borderedProminent)
        .tint(prominent ? Palette.cyan : (choice.isNegative ? Palette.danger.opacity(0.22) : Palette.ring.opacity(0.25)))
        .disabled(chosen != nil)
        .accessibilityLabel(choice.label)
    }
}

/// No pairing yet: the iPhone does that.
struct WatchUnpairedView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 10) {
                    ReactorView(mode: .offline, size: 76)
                    Text("Pair on your iPhone first")
                        .font(.headline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Palette.ink)
                    Text("Open J.A.R.V.I.S. on your iPhone and pair it with your Mac. The Watch picks it up by itself.")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Palette.muted)
                    if let notice = model.notice {
                        Text(notice)
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(Palette.amber)
                    }
                    Button("Check again") { model.checkPhone() }
                        .tint(Palette.cyan)
                        .padding(.top, 4)
                }
            }
            .navigationTitle("JARVIS")
            .containerBackground(for: .navigation) { WatchBackground() }
        }
    }
}
