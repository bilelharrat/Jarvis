import SwiftUI

/// The J.A.R.V.I.S. look, the way Apple builds its own apps: the system's semantic colors
/// (light and dark), SF Pro, grouped lists for content, Liquid Glass only for the controls
/// that float above it, and one accent, Jarvis blue. The names are the app's vocabulary;
/// each resolves to a system color, so every screen follows Dark Mode, Increase Contrast
/// and the owner's text size by itself.
enum Palette {
    // Surfaces
    /// The canvas behind a screen.
    static let space = Color.systemBackground
    /// A card or row on the canvas.
    static let spaceRaised = Color.secondarySystemBackground
    /// An inset well (an approval's exact wording, code).
    static let well = Color.tertiarySystemFill

    // Jarvis blue, the one accent
    static let cyan = Color.accentColor
    static let ring = Color.accentColor
    static let ice = Color.accentColor
    static let deep = Color(hex: 0x0A5BD8)

    // Labels
    static let ink = Color.primary
    static let ink2 = Color.secondary
    static let muted = Color.secondary
    static let hairline = Color.separatorLine

    /// What needs the owner (approvals, a session waiting): the system's orange.
    static let champagne = Color.orange
    static let titanium = Color.secondary

    // Signals
    static let amber = Color.orange
    static let danger = Color.red
    static let online = Color.green

    /// The orb's light, centre to rim.
    static let core: [Color] = [0xF4FBFF, 0x9FD8FF, 0x3D9BFF, 0x2A62F5, 0x5B3BE8].map { Color(hex: $0) }

    /// A filled button.
    static let action = LinearGradient(colors: [Color.accentColor, Color.accentColor], startPoint: .top, endPoint: .bottom)
    static let champagneFoil = LinearGradient(colors: [Color.orange, Color.orange], startPoint: .top, endPoint: .bottom)

    /// Ink on a filled (accent) button.
    static let onAction = Color.white
}

extension Color {
    #if os(iOS)
    static let systemBackground = Color(uiColor: .systemBackground)
    static let secondarySystemBackground = Color(uiColor: .secondarySystemBackground)
    static let systemGroupedBackground = Color(uiColor: .systemGroupedBackground)
    static let secondarySystemGroupedBackground = Color(uiColor: .secondarySystemGroupedBackground)
    static let tertiarySystemFill = Color(uiColor: .tertiarySystemFill)
    static let separatorLine = Color(uiColor: .separator)
    #else
    static let systemBackground = Color.black
    static let secondarySystemBackground = Color(white: 0.11)
    static let systemGroupedBackground = Color.black
    static let secondarySystemGroupedBackground = Color(white: 0.11)
    static let tertiarySystemFill = Color.white.opacity(0.12)
    static let separatorLine = Color.white.opacity(0.15)
    #endif
}

/// The 8-point grid.
enum Space {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let s: CGFloat = 12
    static let m: CGFloat = 16
    static let l: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
}

/// Continuous corner radii (the system's own for cards and grouped lists).
enum Radius {
    static let control: CGFloat = 12
    static let card: CGFloat = 26
    static let sheet: CGFloat = 32
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

extension Font {
    /// Small labels over a value (Weather's module headers), in SF Pro.
    static let hud = Font.footnote.weight(.semibold)
    static let eyebrow = Font.footnote.weight(.semibold)
    static let display = Font.largeTitle.weight(.bold)
    static let serifTitle = Font.title2.weight(.bold)
    static let serifHeadline = Font.title3.weight(.semibold)
    /// Jarvis's own words.
    static let voice = Font.body
}

/// A small label over a value: SF Pro, secondary, the way Apple heads a module.
struct HUDText: View {
    let text: String
    var color: Color = Palette.muted

    init(_ text: String, color: Color = Palette.muted, tracking: CGFloat = 0) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.hud)
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

/// A module header (Weather's "HOURLY FORECAST"): small caps, secondary.
struct Eyebrow: View {
    let text: String
    var color: Color = Palette.muted

    init(_ text: String, color: Color = Palette.muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

/// A content card: a raised, continuous-cornered surface on the canvas (content is never
/// glass; glass is for the controls above it). A tint adds a faint wash and keeps its color
/// for the edge: orange for what needs you, the accent for Jarvis.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = Radius.card
    var tint: Color = .white
    var strength: Double = 1

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let neutral = tint == .white
        content
            .background {
                shape.fill(Color.secondarySystemGroupedBackground)
                    .overlay(shape.fill(neutral ? Color.clear : tint.opacity(0.08 * strength)))
            }
            .overlay {
                if !neutral {
                    shape.strokeBorder(tint.opacity(0.35 * min(strength, 1.5)), lineWidth: 1)
                }
            }
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = Radius.card, tint: Color = .white, strength: Double = 1) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius, tint: tint, strength: strength))
    }

    /// Liquid Glass in any shape, for a control floating over content.
    @ViewBuilder
    func glass<S: Shape>(_ shape: S, tint: Color = .white, strength: Double = 1, interactive: Bool = true) -> some View {
        let glass: Glass = tint == .white ? .regular : .regular.tint(tint.opacity(min(0.9, 0.45 * strength)))
        glassEffect(interactive ? glass.interactive() : glass, in: shape)
    }

    /// Fades a horizontally scrolling row out at its edges, so it reads as "there's more".
    func edgeFade(leading: CGFloat = 12, trailing: CGFloat = 28) -> some View {
        mask(
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: leading)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: trailing)
            }
        )
    }
}

/// Jarvis's mark: a small lit sphere (an avatar for Jarvis's lines, a monogram).
struct OrbMark: View {
    var size: CGFloat = 10
    var glow = true

    var body: some View {
        Circle()
            .fill(AngularGradient(colors: [Palette.core[2], Palette.core[4], Palette.core[1], Palette.core[3], Palette.core[2]], center: .center))
            .overlay(Circle().fill(RadialGradient(colors: [.white.opacity(0.85), .white.opacity(0)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.55)))
            .frame(width: size, height: size)
            .shadow(color: Palette.core[3].opacity(glow ? 0.45 : 0), radius: size * 0.3)
            .accessibilityHidden(true)
    }
}
