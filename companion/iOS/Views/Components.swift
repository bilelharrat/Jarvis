import SwiftUI

/// The one prominent button on a screen (Pair, Brief me): a filled accent capsule, full
/// width, the way iOS sets a primary action.
struct PrimaryButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 0
    var tint: Color = .accentColor
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(isEnabled ? Palette.onAction : Color.secondary)
            .frame(minHeight: 50)
            .background {
                Capsule().fill(isEnabled ? tint : Color.tertiarySystemFill)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.2), value: isEnabled)
    }
}

/// A secondary button: a neutral capsule (suggestions, an approval's other choices).
struct GlassButtonStyle: ButtonStyle {
    var tint: Color = .white
    var cornerRadius: CGFloat = 0

    func makeBody(configuration: Configuration) -> some View {
        let neutral = tint == .white
        configuration.label
            .foregroundStyle(neutral ? Color.primary : tint)
            .background(Capsule().fill(neutral ? Color.tertiarySystemFill : tint.opacity(0.15)))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// A round control floating over content (toolbars, the composer): Liquid Glass.
struct CircleGlassButtonStyle: ButtonStyle {
    var tint: Color = .white

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .glass(Circle(), tint: tint)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.65), value: configuration.isPressed)
    }
}

/// What went wrong and what to do about it.
struct ErrorCallout: View {
    let title: String
    let message: String
    var hint: String?

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .symbolRenderingMode(.multicolor)
                .font(.title3)
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
        .glassCard(cornerRadius: 20)
        .accessibilityElement(children: .combine)
    }
}

/// Three dots while Jarvis thinks.
struct ThinkingDots: View {
    var color: Color = .secondary
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    let phase = (sin(t * 4.2 - Double(index) * 0.9) + 1) / 2
                    Circle()
                        .fill(color)
                        .frame(width: 7, height: 7)
                        .opacity(0.3 + 0.7 * phase)
                }
            }
        }
        .frame(height: 12)
        .accessibilityLabel("Thinking")
    }
}

/// A Settings-app icon: a white glyph on a colored rounded tile.
struct IconTile: View {
    let symbol: String
    var tint: Color = .gray
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 29

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: side * 0.24, style: .continuous)
        Image(systemName: symbol)
            .font(.system(size: side * 0.52, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: side, height: side)
            .background(shape.fill(tileColor.gradient))
            .accessibilityHidden(true)
    }

    /// Label colors (the old graphite tiles' tints) read as gray tiles.
    private var tileColor: Color {
        tint == Palette.ink || tint == Palette.muted ? .gray : tint
    }
}

/// A grouped-list section header, as the system sets it.
struct ListHeader: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
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
    }
}

/// A grouped-list row in glass: a thin material over the night, a breath of light on it.
struct GlassRowBackground: View {
    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Rectangle().fill(Color.white.opacity(0.045)))
    }
}

/// A grouped list, as Settings draws it, every row in glass over the night.
struct GlassList<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        List {
            // A Group hands the row background to every section, and so to every row.
            Group { content }.glassRow()
        }
        .listStyle(.insetGrouped)
        .starkBackdrop(glow: UnitPoint(x: 0.5, y: -0.05))
    }
}

/// A Form, the same way.
struct GlassForm<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Form {
            Group { content }.glassRow()
        }
        .starkBackdrop(glow: UnitPoint(x: 0.5, y: -0.05))
    }
}

extension View {
    /// A grouped list, as Settings draws it (GlassList brings the night and the glass).
    func glassList() -> some View {
        listStyle(.insetGrouped)
    }

    /// Its rows in glass (on a Section, or a row).
    func glassRow() -> some View {
        listRowBackground(GlassRowBackground())
            .listRowSeparatorTint(Color.white.opacity(0.1))
    }
}
