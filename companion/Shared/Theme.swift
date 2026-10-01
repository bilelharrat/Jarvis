import SwiftUI

/// The J.A.R.V.I.S. look: Apple's craft with Stark's materials. SF Pro and Apple's layouts,
/// every surface Liquid Glass over a night lit by the arc reactor, one accent (reactor blue),
/// and Stark gold, sparingly, for what needs the owner. Telemetry in small SF Mono caps.
enum Palette {
    // Surfaces
    /// The canvas behind a screen.
    static let space = Color.systemBackground
    /// A card or row on the canvas.
    static let spaceRaised = Color.secondarySystemBackground
    /// An inset well (an approval's exact wording, code).
    static let well = Color.tertiarySystemFill

    // Reactor blue, the one accent
    static let cyan = Color.accentColor
    static let ring = Color(hex: 0x8FDBFF)
    static let ice = Color(hex: 0xD6F3FF)
    static let deep = Color(hex: 0x0B4FA8)

    // Labels
    static let ink = Color.primary
    static let ink2 = Color.secondary
    static let muted = Color.secondary
    static let hairline = Color.separatorLine

    /// What needs the owner (approvals, a session waiting): Stark gold.
    static let champagne = Color(hex: 0xE8C27A)
    static let titanium = Color.secondary
    /// Hot-rod red, only ever in the backdrop's far corner and for stopping.
    static let hotRod = Color(hex: 0xB3261E)

    // Signals
    static let amber = Color.orange
    static let danger = Color.red
    static let online = Color.green

    /// The reactor's light, centre to rim.
    static let core: [Color] = [0xF2FBFF, 0xA4E4FF, 0x3FB8F2, 0x1677C9, 0x0A3D84].map { Color(hex: $0) }

    /// A filled button.
    static let action = LinearGradient(colors: [Color.accentColor, Color.accentColor], startPoint: .top, endPoint: .bottom)
    static let champagneFoil = LinearGradient(
        colors: [Color(hex: 0xF3E6C8), Color(hex: 0xC4A876), Color(hex: 0xE9D7B2)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    /// Ink on a filled (accent) button.
    static let onAction = Color(hex: 0x03101C)
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
    /// Telemetry: small SF Mono caps.
    static let hud = Font.system(.caption2, design: .monospaced).weight(.semibold)
    static let eyebrow = Font.footnote.weight(.semibold)
    static let display = Font.largeTitle.weight(.bold)
    static let serifTitle = Font.title2.weight(.bold)
    static let serifHeadline = Font.title3.weight(.semibold)
    /// Jarvis's own words.
    static let voice = Font.body
}

/// A telemetry label: SF Mono caps, tracked out, the way a suit's display reads.
struct HUDText: View {
    let text: String
    var color: Color = Palette.muted
    var tracking: CGFloat = 1.4

    init(_ text: String, color: Color = Palette.muted, tracking: CGFloat = 1.4) {
        self.text = text
        self.color = color
        self.tracking = tracking
    }

    var body: some View {
        Text(text.uppercased())
            .font(.hud)
            .tracking(tracking)
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

/// A glass panel: Liquid Glass over the lit night, with a specular rim that catches the
/// light along its top edge. A tint colours the glass and the rim (gold for what needs you).
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = Radius.card
    var tint: Color = .white
    var strength: Double = 1

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let neutral = tint == .white
        content
            .glassEffect(neutral ? .regular : .regular.tint(tint.opacity(0.18 * strength)), in: shape)
            .overlay { SpecularRim(shape: shape, tint: neutral ? .white : tint, strength: strength) }
    }
}

/// The edge of a pane of glass: bright where the light hits the top, almost gone below.
struct SpecularRim<S: InsettableShape>: View {
    let shape: S
    var tint: Color = .white
    var strength: Double = 1

    var body: some View {
        let neutral = tint == .white
        shape.strokeBorder(
            LinearGradient(
                stops: [
                    .init(color: tint.opacity(min(1, (neutral ? 0.28 : 0.7) * strength)), location: 0),
                    .init(color: tint.opacity(neutral ? 0.06 : 0.2), location: 0.45),
                    .init(color: .white.opacity(0.03), location: 0.8),
                    .init(color: .white.opacity(0.08), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            ),
            lineWidth: 0.8
        )
        .allowsHitTesting(false)
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
