import SwiftUI

/// Jarvis needs a yes: the question, what exactly (the detail), and one button per choice.
/// Set apart from everything else by a champagne rim, like a document awaiting a signature.
struct ApprovalCard: View {
    let approval: Approval
    let onChoose: (ApprovalChoice) -> Void

    @State private var chosen: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card + 2, style: .continuous)
        VStack(alignment: .leading, spacing: Space.s + 2) {
            HStack(spacing: Space.xs) {
                // A champagne seal: the shield in foil, the tick cut out of it.
                Image(systemName: "checkmark.shield.fill")
                    .symbolRenderingMode(.palette)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.well, Palette.champagneFoil)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion && chosen == nil)
                Eyebrow("Needs your OK", color: Palette.champagne)
                Spacer()
            }
            .accessibilityHidden(true)

            Text(approval.question)
                .font(.serifHeadline)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if !approval.detail.trimmed.isEmpty {
                let well = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                ScrollView {
                    Text(approval.detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Palette.ink2)
                        .lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(Space.s + 2)
                }
                .frame(maxHeight: 150)
                .fixedSize(horizontal: false, vertical: true)
                .background(well.fill(Palette.well.opacity(0.55)))
                .overlay(well.strokeBorder(
                    LinearGradient(colors: [.black.opacity(0.5), .white.opacity(0.08)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.75
                ))
            }

            choices
                .padding(.top, Space.xxs)
        }
        .padding(Space.m + 2)
        .glassCard(cornerRadius: Radius.card + 2, tint: Palette.champagne, strength: 0.7)
        .overlay(shape.strokeBorder(Palette.champagneFoil, lineWidth: 0.75).opacity(0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jarvis needs your OK")
    }

    @ViewBuilder
    private var choices: some View {
        if approval.choices.count <= 3 {
            HStack(spacing: Space.s - 2) {
                ForEach(approval.choices) { choiceButton($0) }
            }
        } else {
            VStack(spacing: Space.xs) {
                ForEach(approval.choices) { choiceButton($0) }
            }
        }
    }

    private func choiceButton(_ choice: ApprovalChoice) -> some View {
        let primary = choice == approval.primary && !choice.isNegative
        let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        return Button {
            guard chosen == nil else { return }
            chosen = choice.id
            onChoose(choice)
        } label: {
            HStack(spacing: 6) {
                if chosen == choice.id {
                    ProgressView()
                        .controlSize(.small)
                        .tint(primary ? Palette.onAction : Palette.ink)
                }
                Text(choice.label)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 50)
            .padding(.horizontal, Space.xs)
            .foregroundStyle(primary ? Palette.onAction : (choice.isNegative ? Palette.danger : Palette.ink))
            .background {
                if primary {
                    shape.fill(Palette.action)
                        .overlay(shape.strokeBorder(
                            LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0.1)], startPoint: .top, endPoint: .center),
                            lineWidth: 0.75
                        ))
                        .shadow(color: Palette.cyan.opacity(0.35), radius: 14, y: 4)
                }
            }
            .modifier(SecondaryChoice(active: !primary, shape: shape))
        }
        .buttonStyle(PressableStyle())
        .disabled(chosen != nil)
        .opacity(chosen != nil && chosen != choice.id ? 0.4 : 1)
        .accessibilityLabel(choice.label)
        .accessibilityHint(approval.question)
    }
}

/// The other choices: glass, so the one filled button is the obvious yes.
private struct SecondaryChoice: ViewModifier {
    let active: Bool
    let shape: RoundedRectangle

    func body(content: Content) -> some View {
        if active {
            content.glass(shape, strength: 1.1)
        } else {
            content
        }
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
