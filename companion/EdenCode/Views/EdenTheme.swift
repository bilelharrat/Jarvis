import SwiftUI

/// Eden Code's look on the iPhone (the owner's approved mockups, 2026-10-16): Apple's system
/// colours and SF type over a soft blue, violet and teal light, every surface Liquid Glass;
/// light and dark follow the iPhone. The composer is Eden chat's own (EdenComposer).
enum EdenTheme {
    static let accent = Color(light: 0x007AFF, dark: 0x0A84FF)
    static let orange = Color(light: 0xFF9500, dark: 0xFF9F0A)
    static let green = Color(light: 0x34C759, dark: 0x30D158)
    static let red = Color(light: 0xFF3B30, dark: 0xFF453A)
    static let ink = Color(light: 0x1D1D1F, dark: 0xF5F5F7)
    static let ink2 = Color(light: 0x3A3A3C, dark: 0xD1D1D6)
    static let onInk = Color(light: 0xFFFFFF, dark: 0x1D1D1F)
    static let muted = Color(light: 0x6E6E73, dark: 0xAEAEB2)
    static let chevron = Color(light: 0x8E8E93, dark: 0x8E8E93)
    static let checkGreen = Color(light: 0x248A3D, dark: 0x30D158)
    static let needsInk = Color(light: 0xA35200, dark: 0xFFB340)
    static let failInk = Color(light: 0xC4271C, dark: 0xFF6961)
    static let fill = Color(light: 0x787880, dark: 0x787880, lightAlpha: 0.14, darkAlpha: 0.24)
    static let card = Color(light: 0xFFFFFF, dark: 0x2C2C30, lightAlpha: 0.78, darkAlpha: 0.62)
    static let cardRim = Color(light: 0xFFFFFF, dark: 0xFFFFFF, lightAlpha: 0.85, darkAlpha: 0.16)
    static let divider = Color(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.06, darkAlpha: 0.08)
    static let addedBG = Color(light: 0xE6F6EA, dark: 0x1E3A26)
    static let addedInk = Color(light: 0x1B5E2C, dark: 0x8FE3A4)
    static let removedBG = Color(light: 0xFDECEC, dark: 0x45201F)
    static let removedInk = Color(light: 0x9B1C1C, dark: 0xFFA6A0)

    static func dot(_ status: CodeStatus) -> Color {
        switch status {
        case .working: accent
        case .needsYou: orange
        case .done: green
        case .failed: red
        default: chevron
        }
    }

    static func subtitleInk(_ status: CodeStatus) -> Color {
        switch status {
        case .needsYou: needsInk
        case .failed: failInk
        default: muted
        }
    }
}

extension Color {
    /// A colour for light and one for dark, as hex.
    init(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) {
        self = Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: Double = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// The soft lights behind every screen: blue top left, violet right, teal at the bottom.
struct EdenBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        ZStack {
            Color(UIColor(hex: dark ? 0x141A2E : 0xE6ECF7))
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height
                ZStack {
                    glow(dark ? 0x3C5BD8 : 0x9CCBFF, at: CGPoint(x: w * 0.1, y: h * 0.1), radius: max(w, h) * 0.45)
                    glow(dark ? 0x8A3FD1 : 0xD2B6FF, at: CGPoint(x: w * 0.95, y: h * 0.4), radius: max(w, h) * 0.4)
                    glow(dark ? 0x138A8A : 0x8BE6D4, at: CGPoint(x: w * 0.4, y: h), radius: max(w, h) * 0.45)
                }
            }
        }
        .ignoresSafeArea()
    }

    private func glow(_ hex: UInt32, at center: CGPoint, radius: CGFloat) -> some View {
        RadialGradient(colors: [Color(UIColor(hex: hex)), Color(UIColor(hex: hex, alpha: 0))], center: .center, startRadius: 0, endRadius: radius)
            .frame(width: radius * 2, height: radius * 2)
            .position(center)
    }
}

/// A grouped surface: the mockups' white glass card (18–20 pt corners, a bright rim).
struct EdenGlassCard: ViewModifier {
    var radius: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .background(EdenTheme.card, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(EdenTheme.cardRim, lineWidth: 1))
    }
}

extension View {
    func edenCard(radius: CGFloat = 18) -> some View { modifier(EdenGlassCard(radius: radius)) }
}

/// A small round glass button (back, changes), 34 pt.
struct RoundGlassButton: View {
    var symbol: String
    var label: String
    var size: CGFloat = 34
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(EdenTheme.ink)
                .frame(width: size, height: size)
                .background(EdenTheme.fill, in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A status dot (10 pt).
struct StatusDot: View {
    var status: CodeStatus
    var body: some View {
        Circle().fill(EdenTheme.dot(status)).frame(width: 10, height: 10)
            .accessibilityHidden(true)
    }
}

/// A capsule chip (mode, model, Stop, Read aloud…).
struct Chip: View {
    var text: String
    var symbol: String?
    var tint: Color = EdenTheme.ink
    var fill: Color = EdenTheme.fill
    var chevron = false

    var body: some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .semibold)) }
            Text(text).lineLimit(1)
            if chevron { Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)) }
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(fill, in: .capsule)
    }
}
