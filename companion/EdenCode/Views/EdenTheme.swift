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

/// The G design's wallpaper (GChat.dc.html, 2026-10-16): four soft lights over a pale blue,
/// as the mockup's four CSS radial gradients draw them (blue top left, violet right, teal low
/// left, peach bottom right; each fades out at its own share of the farthest corner). Dark is
/// the same lights, deeper, over a night blue, so the glass on top reads the same way.
struct EdenBackground: View {
    @Environment(\.colorScheme) private var scheme

    /// x and y as a share of the screen, the colour light and dark, and where it has faded.
    static let lights: [(x: CGFloat, y: CGFloat, light: UInt32, dark: UInt32, fade: CGFloat)] = [
        (0.85, 0.95, 0xFFC9A8, 0x5A3A4E, 0.40),
        (0.25, 0.78, 0x8BE6D4, 0x14585A, 0.45),
        (0.92, 0.38, 0xCDB2FF, 0x4A3591, 0.42),
        (0.12, 0.08, 0x8EC2FF, 0x24479A, 0.45),
    ]

    var body: some View {
        let dark = scheme == .dark
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Color(UIColor(hex: dark ? 0x0E1220 : 0xE4EAF6))
                ForEach(0..<Self.lights.count, id: \.self) { index in
                    let light = Self.lights[index]
                    let center = CGPoint(x: w * light.x, y: h * light.y)
                    // CSS "circle" sizes to the farthest corner.
                    let far = max(hypot(center.x, center.y), hypot(w - center.x, center.y),
                                  hypot(center.x, h - center.y), hypot(w - center.x, h - center.y))
                    let hex = dark ? light.dark : light.light
                    RadialGradient(colors: [Color(UIColor(hex: hex)), Color(UIColor(hex: hex, alpha: 0))],
                                   center: UnitPoint(x: light.x, y: light.y), startRadius: 0, endRadius: far * light.fade)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// The G design's glass: Liquid Glass (iOS 26's `.glassEffect`) carrying the mockup's milky
/// white (42 % over a 24 pt blur), its bright rim, and its soft blue shadow. Dark derives from
/// it: a smoky glass, a faint rim, a deeper shadow.
struct GGlass<S: InsettableShape>: ViewModifier {
    var shape: S
    /// The mockup's white: 0.42 for controls and bubbles, 0.5 for the input bar, 0.55 for the ask card.
    var white: Double = 0.42
    /// The mockup's shadow: 0 6 18 (controls), 0 16 40 (the ask card).
    var shadowRadius: CGFloat = 9
    var shadowY: CGFloat = 6
    var shadowOpacity: Double = 0.10
    var interactive = false
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let dark = scheme == .dark
        content
            .background {
                // Liquid Glass frosts on its own; half the mockup's white on top of it reads as the
                // mockup's milky 42 %.
                shape.fill(dark ? Color(UIColor(hex: 0x2A2F45, alpha: white * 0.8)) : Color.white.opacity(white * 0.5))
            }
            .overlay {
                ZStack {
                    shape.strokeBorder(Color.white.opacity(dark ? 0.10 : 0.55), lineWidth: 1)
                    shape.strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(dark ? 0.22 : 0.95), location: 0),
                                                              .init(color: .clear, location: 0.18)],
                                                      startPoint: .top, endPoint: .bottom), lineWidth: 1)
                }
                .allowsHitTesting(false)
            }
            .glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
            .shadow(color: dark ? .black.opacity(shadowOpacity * 3.5) : Color(UIColor(hex: 0x283C78, alpha: shadowOpacity)),
                    radius: shadowRadius, y: shadowY)
    }
}

extension View {
    /// The G design's glass in a shape (see GGlass).
    func gGlass<S: InsettableShape>(_ shape: S, white: Double = 0.42, shadowRadius: CGFloat = 9, shadowY: CGFloat = 6,
                                    shadowOpacity: Double = 0.10, interactive: Bool = false) -> some View {
        modifier(GGlass(shape: shape, white: white, shadowRadius: shadowRadius, shadowY: shadowY,
                        shadowOpacity: shadowOpacity, interactive: interactive))
    }
}

/// One word for where a session is, and its colour (G1's title pill, G2's drawer rows).
enum GStatus {
    /// The title pill: "Working", "Needs your OK", "Done".
    static func word(_ status: CodeStatus) -> String {
        switch status {
        case .working: "Working"
        case .needsYou: "Needs your OK"
        case .done: "Done"
        case .failed: "Failed"
        case .idle, .resting: "Waiting"
        case .unknown: "Session"
        }
    }

    /// The drawer: "Working…", "Needs your OK", "Done · ready to review".
    static func drawerWord(_ status: CodeStatus) -> String {
        switch status {
        case .working: "Working…"
        case .done: "Done · ready to review"
        default: word(status)
        }
    }

    /// The word's ink (orange-brown, blue, green, red; grey otherwise).
    static func ink(_ status: CodeStatus) -> Color {
        switch status {
        case .working: EdenTheme.accent
        case .needsYou: Color(light: 0xC93400, dark: 0xFFB340)
        case .done: EdenTheme.checkGreen
        case .failed: EdenTheme.failInk
        default: EdenTheme.muted
        }
    }
}

/// The navy tile with the Eden mark (G2's Mac, G3's hero).
struct EdenMarkTile: View {
    var size: CGFloat
    var mark: CGFloat
    var radius: CGFloat
    var line: CGFloat

    var body: some View {
        EdenMark()
            .stroke(.white, style: StrokeStyle(lineWidth: line, lineJoin: .round))
            .frame(width: mark, height: mark)
            .frame(width: size, height: size)
            .background(Color(light: 0x0E2747, dark: 0x1D3C66), in: .rect(cornerRadius: radius, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A 14 pt ring turning (the mockups' "working" spinner).
struct Spinner: View {
    var size: CGFloat = 14
    @State private var turning = false

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(EdenTheme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .butt))
            .frame(width: size - 2, height: size - 2)
            .rotationEffect(.degrees(turning ? 360 : 45))
            .frame(width: size, height: size)
            .onAppear {
                withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turning = true }
            }
            .accessibilityHidden(true)
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
