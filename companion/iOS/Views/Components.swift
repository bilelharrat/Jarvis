import SwiftUI

/// The one filled button on a screen (Pair, an approval's yes): reactor blue, lit from
/// above, with a specular top edge.
struct PrimaryButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = Radius.control + 2
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return configuration.label
            .font(.headline)
            .foregroundStyle(isEnabled ? Palette.onAction : Palette.muted)
            .background {
                if isEnabled {
                    shape.fill(Palette.action)
                        .overlay(shape.strokeBorder(
                            LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0.1)], startPoint: .top, endPoint: .center),
                            lineWidth: 0.75
                        ))
                        .shadow(color: Palette.cyan.opacity(configuration.isPressed ? 0.2 : 0.35), radius: 18, y: 6)
                } else {
                    Color.clear.glassCard(cornerRadius: cornerRadius, strength: 0.7)
                }
            }
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .brightness(configuration.isPressed ? -0.04 : 0)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.25), value: isEnabled)
    }
}

/// Glass buttons (suggestions, secondary choices, rows that act).
struct GlassButtonStyle: ButtonStyle {
    var tint: Color = .white
    var cornerRadius: CGFloat = Radius.control

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .glassCard(cornerRadius: cornerRadius, tint: tint, strength: configuration.isPressed ? 1.9 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// A round glass button (the top bar, quick actions).
struct CircleGlassButtonStyle: ButtonStyle {
    var tint: Color = .white

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .glass(Circle(), tint: tint, strength: configuration.isPressed ? 2 : 1)
            .scaleEffect(configuration.isPressed ? 0.93 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.65), value: configuration.isPressed)
    }
}

/// A step heading: a small numbered medallion and the step's name.
struct SectionLabel: View {
    let number: String
    let title: String

    var body: some View {
        HStack(spacing: 10) {
            Text(String(Int(number) ?? 0))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Palette.ink)
                .frame(minWidth: 22, minHeight: 22)
                .glass(Circle(), strength: 1.2)
            Text(title)
                .font(.headline)
                .foregroundStyle(Palette.ink)
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
        HStack(alignment: .top, spacing: Space.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .symbolRenderingMode(.hierarchical)
                .font(.title3)
                .foregroundStyle(Palette.amber)
            VStack(alignment: .leading, spacing: Space.xxs) {
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
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Space.m)
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
                    let phase = (sin(t * 4.2 - Double(index) * 0.9) + 1) / 2
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

/// An Apple-Settings-style icon: a small graphite tile with a white glyph.
struct IconTile: View {
    let symbol: String
    var tint: Color = Palette.ink
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 30

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: side * 0.26, style: .continuous)
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: side * 0.5, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: side, height: side)
            .background(shape.fill(LinearGradient(colors: [Color(hex: 0x3A3F49), Color(hex: 0x1C2027)], startPoint: .top, endPoint: .bottom)))
            .overlay(shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.28), .white.opacity(0.04)], startPoint: .top, endPoint: .bottom), lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

/// A Settings-style row on glass (a Form or List row background), with the Form's own
/// grouping and continuous corners.
struct GlassRowBackground: View {
    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Rectangle().fill(Palette.spaceRaised.opacity(0.66)))
            .overlay(Rectangle().fill(Color.white.opacity(0.035)))
    }
}

/// A grouped-list section header, the way Settings sets it.
struct ListHeader: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Palette.muted)
            .textCase(.uppercase)
            .tracking(0.6)
    }
}

/// A grouped-list section footer.
struct ListFooter: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.muted)
    }
}

extension View {
    /// The companion's grouped list: glass rows on the night, hairline separators.
    func glassList() -> some View {
        scrollContentBackground(.hidden)
            .listSectionSpacing(Space.l)
            .environment(\.defaultMinListRowHeight, 52)
    }

    func glassRow() -> some View {
        listRowBackground(GlassRowBackground())
            .listRowSeparatorTint(Palette.hairline)
    }
}
