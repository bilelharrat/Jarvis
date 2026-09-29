import SwiftUI

/// The bright, filled button (Pair, Send).
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return configuration.label
            .font(.headline)
            .foregroundStyle(isEnabled ? Palette.space : Palette.muted)
            .background {
                if isEnabled {
                    shape.fill(Palette.action)
                        .overlay(shape.strokeBorder(.white.opacity(0.35), lineWidth: 0.75))
                        .shadow(color: Palette.cyan.opacity(0.45), radius: 14, y: 2)
                } else {
                    Color.clear.glassCard(cornerRadius: 16, strength: 0.6)
                }
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.25), value: isEnabled)
    }
}

/// Glass pill buttons (quick actions, secondary choices).
struct GlassButtonStyle: ButtonStyle {
    var tint: Color = Palette.cyan
    var cornerRadius: CGFloat = 14

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .glassCard(cornerRadius: cornerRadius, tint: tint, strength: configuration.isPressed ? 1.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// "01 · YOUR MAC"
struct SectionLabel: View {
    let number: String
    let title: String

    var body: some View {
        HStack(spacing: 8) {
            Text(number)
                .font(.hud)
                .foregroundStyle(Palette.cyan)
            Rectangle()
                .fill(Palette.cyan.opacity(0.5))
                .frame(width: 14, height: 1)
            HUDText(title, color: Palette.ink2)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isHeader)
    }
}

/// An amber card: what went wrong and what to do about it.
struct ErrorCallout: View {
    let title: String
    let message: String
    var hint: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title3)
                .foregroundStyle(Palette.amber)
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassCard(cornerRadius: 18, tint: Palette.amber)
        .accessibilityElement(children: .combine)
    }
}

/// Three dots while Jarvis thinks.
struct ThinkingDots: View {
    var color: Color = Palette.cyan
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    let phase = (sin(t * 5 - Double(index) * 0.9) + 1) / 2
                    Circle()
                        .fill(color)
                        .frame(width: 6, height: 6)
                        .opacity(0.25 + 0.75 * phase)
                        .scaleEffect(0.8 + 0.3 * phase)
                }
            }
        }
        .frame(height: 12)
        .accessibilityLabel("Thinking")
    }
}
