import SwiftUI

/// Jarvis needs a yes: the question, what exactly (the detail), and one button per choice.
/// Set apart from everything else by a champagne rim, like a document awaiting a signature.
struct ApprovalCard: View {
    let approval: Approval
    let onChoose: (ApprovalChoice) -> Void
    /// "No, because…": a no that says what to do instead.
    var onReason: ((String) -> Void)?

    @State private var chosen: String?
    @State private var explaining = false
    @State private var reason = ""
    @FocusState private var reasonFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card + 2, style: .continuous)
        VStack(alignment: .leading, spacing: Space.s + 2) {
            HStack(spacing: Space.xs) {
                // A champagne seal: the shield in foil, the tick cut out of it.
                Image(systemName: "checkmark.shield.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.champagne)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion && chosen == nil)
                Eyebrow(approval.source == .code ? "Jarvis Code needs your OK" : "Needs your OK", color: Palette.champagne)
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
                .background(well.fill(Palette.well))
            }

            choices
                .padding(.top, Space.xxs)

            if onReason != nil {
                reasonRow
            }
        }
        .padding(Space.m + 2)
        .background(shape.fill(Color.secondarySystemGroupedBackground))
        .overlay(shape.strokeBorder(Palette.champagne.opacity(0.45), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jarvis needs your OK")
    }

    /// A quiet "No, because…" that opens into a line to say why (or what to do instead).
    @ViewBuilder
    private var reasonRow: some View {
        if explaining {
            let well = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            HStack(alignment: .bottom, spacing: Space.xs) {
                TextField("", text: $reason, prompt: Text("No, because…").foregroundStyle(Palette.muted), axis: .vertical)
                    .lineLimit(1...4)
                    .focused($reasonFocused)
                    .submitLabel(.send)
                    .onSubmit(sendReason)
                    .foregroundStyle(Palette.ink)
                    .padding(.vertical, Space.s)
                    .padding(.leading, Space.s + 2)
                    .accessibilityLabel("Why not")
                Button(action: sendReason) {
                    Image(systemName: "arrow.up")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(reason.trimmed.isEmpty ? Palette.muted : Palette.onAction)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(reason.trimmed.isEmpty ? Color.tertiarySystemFill : Color.accentColor))
                }
                .buttonStyle(PressableStyle())
                .disabled(reason.trimmed.isEmpty || chosen != nil)
                .padding(.trailing, 6)
                .padding(.bottom, 6)
                .accessibilityLabel("Send no, with the reason")
            }
            .background(well.fill(Palette.well))
            .transition(.opacity.combined(with: .move(edge: .top)))
        } else {
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { explaining = true }
                reasonFocused = true
            } label: {
                Label("No, because…", systemImage: "text.bubble")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink2)
            }
            .buttonStyle(.plain)
            .disabled(chosen != nil)
            .accessibilityHint("Say no, and tell Jarvis why or what to do instead")
        }
    }

    private func sendReason() {
        let text = reason.trimmed
        guard !text.isEmpty, chosen == nil, let onReason else { return }
        chosen = ApprovalResponse.negative(in: approval.choices)
        reasonFocused = false
        onReason(text)
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
        let shape = Capsule()
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
                    shape.fill(Color.accentColor)
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
    let shape: Capsule

    func body(content: Content) -> some View {
        if active {
            content.background(shape.fill(Color.tertiarySystemFill))
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
