import SwiftUI

/// The J.A.R.V.I.S. look: an obsidian night, one reactor-blue accent, glass with a
/// specular rim, precise hairlines, and a touch of champagne for what needs you.
enum Palette {
    // Night
    /// The canvas: near-black with a breath of blue.
    static let space = Color(hex: 0x05070C)
    /// A raised surface (rows, wells).
    static let spaceRaised = Color(hex: 0x0F131B)
    /// An inset well, darker than the canvas (an approval's exact wording).
    static let well = Color(hex: 0x020306)

    // Reactor blue, the one accent
    static let cyan = Color(hex: 0x5CC8F7)
    static let ring = Color(hex: 0x7FD4FF)
    static let ice = Color(hex: 0xD6F3FF)
    static let deep = Color(hex: 0x1677C9)

    // Ink (Apple's dark-mode label ramp, cooled a little)
    static let ink = Color(hex: 0xF5F6F8)
    static let ink2 = Color(hex: 0xB9BFCA)
    static let muted = Color(hex: 0x7D8696)
    static let hairline = Color.white.opacity(0.09)

    // Metal: used sparingly, for what needs the owner (approvals) and ownership details
    static let champagne = Color(hex: 0xD9C49C)
    static let titanium = Color(hex: 0xA9ADB5)

    // Signals
    static let amber = Color(hex: 0xF4B266)
    static let danger = Color(hex: 0xFF6259)
    static let online = Color(hex: 0x3DD68C)

    /// The reactor core, centre to rim (the desktop orb's stops).
    static let core: [Color] = [0xF2FBFF, 0xA4E4FF, 0x3FB8F2, 0x1677C9, 0x0A3D84].map { Color(hex: $0) }

    /// Filled buttons: lit from above, like the core.
    static let action = LinearGradient(colors: [Color(hex: 0x9FE3FF), Color(hex: 0x45B4EE)], startPoint: .top, endPoint: .bottom)

    /// Brushed champagne, for a metallic hairline.
    static let champagneFoil = LinearGradient(
        colors: [Color(hex: 0xF3E6C8), Color(hex: 0xC4A876), Color(hex: 0xE9D7B2), Color(hex: 0xB89A68)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    /// Ink on a filled (reactor-blue) button.
    static let onAction = Color(hex: 0x03101C)
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

/// Continuous corner radii.
enum Radius {
    static let control: CGFloat = 14
    static let card: CGFloat = 22
    static let sheet: CGFloat = 28
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
    /// Telemetry: small uppercase SF Mono; scales with Dynamic Type.
    static let hud = Font.system(.caption2, design: .monospaced).weight(.semibold)
    /// Section and card labels: small uppercase SF Pro (Weather's module headers).
    static let eyebrow = Font.caption.weight(.semibold)
    /// Display moments in New York, the native cousin of the desktop's Fraunces.
    static let display = Font.system(.largeTitle, design: .serif).weight(.medium)
    static let serifTitle = Font.system(.title2, design: .serif).weight(.medium)
    static let serifHeadline = Font.system(.title3, design: .serif).weight(.medium)
    /// Jarvis's own words.
    static let voice = Font.system(.body, design: .serif)
}

/// A telemetry label: uppercase SF Mono with letter-spacing.
struct HUDText: View {
    let text: String
    var color: Color = Palette.muted
    var tracking: CGFloat = 1.6

    init(_ text: String, color: Color = Palette.muted, tracking: CGFloat = 1.6) {
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

/// A small uppercase SF Pro label, the way Apple heads a module.
struct Eyebrow: View {
    let text: String
    var color: Color = Palette.muted

    init(_ text: String, color: Color = Palette.muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text.uppercased())
            .font(.eyebrow)
            .tracking(0.9)
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

/// Glass: a real material, darkened to the night, with a specular rim that catches the
/// light along its top edge and a soft shadow beneath. A tint colours the rim and a faint
/// wash (amber for trouble, champagne for approvals); white keeps it neutral.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = Radius.card
    var tint: Color = .white
    var strength: Double = 1

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let neutral = tint == .white
        content
            .background {
                shape
                    .fill(.ultraThinMaterial)
                    .overlay(shape.fill(Palette.spaceRaised.opacity(0.62)))
                    .overlay(shape.fill(LinearGradient(
                        colors: [
                            (neutral ? Color.white : tint).opacity((neutral ? 0.045 : 0.10) * strength),
                            (neutral ? Color.white : tint).opacity(neutral ? 0.0 : 0.02 * strength),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )))
                    .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
            }
            .overlay {
                shape.strokeBorder(
                    LinearGradient(
                        stops: [
                            .init(color: (neutral ? Color.white : tint).opacity(min(1, (neutral ? 0.20 : 0.55) * strength)), location: 0),
                            .init(color: (neutral ? Color.white : tint).opacity(neutral ? 0.07 : 0.18 * strength), location: 0.4),
                            .init(color: Color.white.opacity(0.04), location: 0.75),
                            .init(color: Color.white.opacity(0.07), location: 1),
                        ],
                        startPoint: .top, endPoint: .bottom
                    ),
                    lineWidth: 0.75
                )
            }
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = Radius.card, tint: Color = .white, strength: Double = 1) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius, tint: tint, strength: strength))
    }

    /// Glass in any shape (circles, capsules).
    func glass<S: InsettableShape>(_ shape: S, tint: Color = .white, strength: Double = 1) -> some View {
        let neutral = tint == .white
        return background {
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.fill(Palette.spaceRaised.opacity(0.62)))
                .overlay(shape.fill((neutral ? Color.white : tint).opacity((neutral ? 0.05 : 0.12) * strength)))
                .shadow(color: .black.opacity(0.3), radius: 12, y: 6)
        }
        .overlay {
            shape.strokeBorder(
                LinearGradient(
                    stops: [
                        .init(color: (neutral ? Color.white : tint).opacity(min(1, (neutral ? 0.22 : 0.6) * strength)), location: 0),
                        .init(color: Color.white.opacity(0.05), location: 0.5),
                        .init(color: Color.white.opacity(0.08), location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom
                ),
                lineWidth: 0.75
            )
        }
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

/// The reactor's core as a small mark (a "J" avatar for Jarvis's lines, a monogram).
struct OrbMark: View {
    var size: CGFloat = 10
    var glow = true

    var body: some View {
        Circle()
            .fill(RadialGradient(
                stops: [
                    .init(color: Palette.core[0], location: 0),
                    .init(color: Palette.core[1], location: 0.16),
                    .init(color: Palette.core[2], location: 0.44),
                    .init(color: Palette.core[3], location: 0.72),
                    .init(color: Palette.core[4], location: 1),
                ],
                center: UnitPoint(x: 0.36, y: 0.32), startRadius: 0, endRadius: size * 0.9
            ))
            .frame(width: size, height: size)
            .shadow(color: Palette.cyan.opacity(glow ? 0.55 : 0), radius: size * 0.35)
            .accessibilityHidden(true)
    }
}
