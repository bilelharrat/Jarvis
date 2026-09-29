import SwiftUI

/// Jarvis needs a yes: the question, what exactly (the detail), and one button per choice.
struct ApprovalCard: View {
    let approval: Approval
    let onChoose: (ApprovalChoice) -> Void

    @State private var chosen: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(Palette.amber)
                    .symbolEffect(.pulse, options: .repeating)
                HUDText("Needs your OK", color: Palette.amber)
                Spacer()
            }
            .accessibilityHidden(true)

            Text(approval.question)
                .font(.headline)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if !approval.detail.trimmed.isEmpty {
                ScrollView {
                    Text(approval.detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Palette.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(12)
                }
                .frame(maxHeight: 150)
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.black.opacity(0.28)))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.ring.opacity(0.12), lineWidth: 0.75))
            }

            choices
        }
        .padding(16)
        .glassCard(cornerRadius: 22, tint: Palette.amber, strength: 1.2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jarvis needs your OK")
    }

    @ViewBuilder
    private var choices: some View {
        if approval.choices.count <= 3 {
            HStack(spacing: 10) {
                ForEach(approval.choices) { choiceButton($0) }
            }
        } else {
            VStack(spacing: 8) {
                ForEach(approval.choices) { choiceButton($0) }
            }
        }
    }

    private func choiceButton(_ choice: ApprovalChoice) -> some View {
        let primary = choice == approval.primary && !choice.isNegative
        return Button {
            guard chosen == nil else { return }
            chosen = choice.id
            onChoose(choice)
        } label: {
            HStack(spacing: 6) {
                if chosen == choice.id {
                    ProgressView()
                        .controlSize(.small)
                        .tint(primary ? Palette.space : Palette.ink)
                }
                Text(choice.label)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 46)
            .foregroundStyle(primary ? Palette.space : (choice.isNegative ? Palette.danger : Palette.ink))
            .background {
                let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
                if primary {
                    shape.fill(Palette.action)
                        .shadow(color: Palette.cyan.opacity(0.4), radius: 10)
                } else if choice.isNegative {
                    shape.fill(Palette.danger.opacity(0.10))
                        .overlay(shape.strokeBorder(Palette.danger.opacity(0.55), lineWidth: 1))
                } else {
                    shape.fill(.ultraThinMaterial)
                        .overlay(shape.strokeBorder(Palette.ring.opacity(0.35), lineWidth: 0.75))
                }
            }
        }
        .buttonStyle(PressableStyle())
        .disabled(chosen != nil)
        .opacity(chosen != nil && chosen != choice.id ? 0.45 : 1)
        .accessibilityLabel(choice.label)
        .accessibilityHint(approval.question)
    }
}

/// Just the press feedback, for buttons that draw their own look.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .brightness(configuration.isPressed ? 0.06 : 0)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
