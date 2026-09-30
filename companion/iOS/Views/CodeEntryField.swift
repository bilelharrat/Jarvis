import SwiftUI

/// Six glass digit wells over one hidden number field: typing moves along the wells,
/// delete moves back, and a pasted or auto-filled code fills them all.
struct CodeEntryField: View {
    @Binding var code: String
    var length = 6
    var focused: FocusState<Bool>.Binding
    var invalid = false

    var body: some View {
        ZStack {
            TextField("", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused(focused)
                .frame(width: 1, height: 1)
                .opacity(0.02)
                .accessibilityLabel("Pairing code")
                .accessibilityHint("The six digits shown on your Mac")
                .onChange(of: code) { _, value in
                    let digits = String(value.filter(\.isNumber).prefix(length))
                    if digits != value { code = digits }
                }

            HStack(spacing: Space.xs) {
                ForEach(0..<length, id: \.self) { index in
                    DigitBox(
                        digit: digit(at: index),
                        active: focused.wrappedValue && index == min(code.count, length - 1),
                        invalid: invalid
                    )
                    if index == length / 2 - 1 {
                        // Three and three, the way the Mac shows it.
                        Capsule()
                            .fill(Palette.muted.opacity(0.5))
                            .frame(width: 8, height: 2)
                    }
                }
            }
            .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
        .contextMenu {
            Button("Paste", systemImage: "doc.on.clipboard") {
                if let text = UIPasteboard.general.string {
                    code = String(text.filter(\.isNumber).prefix(length))
                }
            }
        }
    }

    private func digit(at index: Int) -> String? {
        guard index < code.count else { return nil }
        return String(code[code.index(code.startIndex, offsetBy: index)])
    }
}

private struct DigitBox: View {
    let digit: String?
    let active: Bool
    let invalid: Bool

    @ScaledMetric(relativeTo: .title) private var height: CGFloat = 62

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        ZStack {
            if let digit {
                Text(digit)
                    .font(.system(.title, design: .rounded).weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else if active {
                Caret(color: invalid ? Palette.amber : Palette.cyan)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .glassCard(cornerRadius: 14, tint: invalid ? Palette.amber : (active ? Palette.cyan : .white), strength: active ? 1.1 : 0.8)
        .overlay(shape.strokeBorder(borderColor, lineWidth: active ? 1.25 : 0))
        .shadow(color: active ? Palette.cyan.opacity(0.35) : .clear, radius: 10)
        .animation(.spring(response: 0.28, dampingFraction: 0.7), value: digit)
        .animation(.easeOut(duration: 0.2), value: active)
    }

    private var borderColor: Color {
        if invalid { return Palette.amber.opacity(0.7) }
        if active { return Palette.cyan.opacity(0.9) }
        return .clear
    }
}

private struct Caret: View {
    var color: Color = Palette.cyan
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.55)) { timeline in
            let on = reduceMotion || Int(timeline.date.timeIntervalSinceReferenceDate / 0.55).isMultiple(of: 2)
            RoundedRectangle(cornerRadius: 1)
                .fill(color)
                .frame(width: 2, height: 26)
                .opacity(on ? 1 : 0.15)
        }
    }
}
