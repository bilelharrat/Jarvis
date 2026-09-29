import SwiftUI

/// Six large digit boxes over one hidden number field: typing moves along the boxes,
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

            HStack(spacing: 8) {
                ForEach(0..<length, id: \.self) { index in
                    DigitBox(
                        digit: digit(at: index),
                        active: focused.wrappedValue && index == min(code.count, length - 1),
                        invalid: invalid
                    )
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

    @ScaledMetric(relativeTo: .title) private var height: CGFloat = 60

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        ZStack {
            if let digit {
                Text(digit)
                    .font(.system(.title, design: .monospaced).weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else if active {
                Caret()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(shape.fill(.ultraThinMaterial))
        .background(shape.fill(Palette.cyan.opacity(active ? 0.10 : 0.03)))
        .overlay(
            shape.strokeBorder(borderColor, lineWidth: active ? 1.5 : 0.75)
        )
        .shadow(color: active ? Palette.cyan.opacity(0.45) : .clear, radius: 10)
        .animation(.spring(response: 0.28, dampingFraction: 0.7), value: digit)
        .animation(.easeOut(duration: 0.2), value: active)
    }

    private var borderColor: Color {
        if invalid { return Palette.amber.opacity(0.8) }
        if active { return Palette.cyan }
        return digit == nil ? Palette.ring.opacity(0.22) : Palette.ring.opacity(0.5)
    }
}

private struct Caret: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.55)) { timeline in
            let on = Int(timeline.date.timeIntervalSinceReferenceDate / 0.55).isMultiple(of: 2)
            RoundedRectangle(cornerRadius: 1)
                .fill(Palette.cyan)
                .frame(width: 2, height: 26)
                .opacity(on ? 1 : 0.15)
        }
    }
}
