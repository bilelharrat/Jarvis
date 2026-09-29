import SwiftUI

/// The J.A.R.V.I.S. look: deep space, reactor cyan, thin hairlines, HUD labels.
enum Palette {
    static let space = Color(hex: 0x060B16)
    static let spaceRaised = Color(hex: 0x0C1628)
    static let cyan = Color(hex: 0x4FD3FF)
    static let ring = Color(hex: 0x6FD0FF)
    static let ice = Color(hex: 0xC8F4FF)
    static let deep = Color(hex: 0x1677C9)
    static let ink = Color(hex: 0xEEF3FB)
    static let ink2 = Color(hex: 0xC3CFDF)
    static let muted = Color(hex: 0x8193AA)
    static let hairline = Color(hex: 0x22304A)
    static let amber = Color(hex: 0xF5B26B)
    static let danger = Color(hex: 0xFF6B6B)
    static let online = Color(hex: 0x5FE0A0)

    /// The reactor core, centre to rim.
    static let core: [Color] = [0xF2FBFF, 0xA4E4FF, 0x3FB8F2, 0x1677C9, 0x0A3D84].map { Color(hex: $0) }

    /// Filled buttons: bright at the top like the core.
    static let action = LinearGradient(colors: [Color(hex: 0x8FE3FF), Color(hex: 0x3FB8F2)], startPoint: .top, endPoint: .bottom)
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
    /// Small uppercase HUD labels (SF Mono); scales with Dynamic Type.
    static let hud = Font.system(.caption2, design: .monospaced).weight(.semibold)
}

/// A HUD label: uppercase SF Mono with letter-spacing.
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

/// Frosted glass with a thin cyan hairline, the companion's card material.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 20
    var tint: Color = Palette.cyan
    var strength: Double = 1

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                shape
                    .fill(.ultraThinMaterial)
                    .overlay(shape.fill(Palette.space.opacity(0.55)))  // navy glass, not grey
                    .overlay(shape.fill(LinearGradient(
                        colors: [tint.opacity(0.13 * strength), tint.opacity(0.02 * strength)],
                        startPoint: .top, endPoint: .bottom
                    )))
            }
            .overlay {
                shape.strokeBorder(
                    LinearGradient(colors: [tint.opacity(0.55 * strength), tint.opacity(0.12 * strength)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.75
                )
            }
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 20, tint: Color = Palette.cyan, strength: Double = 1) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius, tint: tint, strength: strength))
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
