import SwiftUI

/// How the app looks, as on the Mac (Settings › Look there): Stark Glass, every surface Liquid
/// Glass over a night lit by the reactor (the default, always dark), or Obsidian, a quiet
/// instrument: flat graphite at night and porcelain by day (following the iPhone's
/// appearance), hairlines instead of glass, the reactor as a fine-ticked dial, and two colours
/// that mean something: arc blue is alive, brass needs you. The Mac's obsidian.css tokens,
/// colour for colour.
///
/// The choice is read once (`Look.current`) and the app is rebuilt when it changes (the
/// root view is keyed by it), so Palette and the shared views simply ask what's current.
enum Look: String, CaseIterable, Identifiable, Sendable {
    case starkGlass = "glass"
    case obsidian

    static let key = "look"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .starkGlass: "Stark Glass"
        case .obsidian: "Obsidian"
        }
    }

    var summary: String {
        switch self {
        case .starkGlass: "Liquid Glass over a night lit by the reactor. Always dark."
        case .obsidian: "Flat graphite at night, porcelain by day, with a fine-ticked dial. Follows your iPhone’s appearance."
        }
    }

    /// The look in use. Only the iPhone app offers a choice; the Watch and widgets stay Stark Glass.
    nonisolated(unsafe) static var current: Look = stored

    static var stored: Look {
        #if os(iOS)
        UserDefaults.standard.string(forKey: key).flatMap(Look.init) ?? .starkGlass
        #else
        .starkGlass
        #endif
    }

    static var isObsidian: Bool { current == .obsidian }
}

extension Color {
    /// One colour at night and another by day (Obsidian follows the iPhone's appearance;
    /// Stark Glass is always night).
    static func look(night: UInt32, day: UInt32, nightOpacity: Double = 1, dayOpacity: Double = 1) -> Color {
        #if os(iOS)
        Color(uiColor: UIColor { traits in
            let (hex, opacity) = traits.userInterfaceStyle == .light ? (day, dayOpacity) : (night, nightOpacity)
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: CGFloat(opacity)
            )
        })
        #else
        Color(hex: night, opacity: nightOpacity)
        #endif
    }
}

/// Obsidian's tokens (the Mac's obsidian.css: graphite at night, porcelain by day).
enum Obsidian {
    static let bg = Color.look(night: 0x0A0B0D, day: 0xF4F5F7)
    static let surface = Color.look(night: 0x111215, day: 0xFFFFFF)
    static let raised = Color.look(night: 0x16181C, day: 0xECEEF2)
    static let ink = Color.look(night: 0xEDEEF0, day: 0x111317)
    static let ink2 = Color.look(night: 0xA7ABB3, day: 0x4A4F57)
    static let muted = Color.look(night: 0x7D828C, day: 0x646A73)
    static let hair = Color.look(night: 0xFFFFFF, day: 0x0A0C10, nightOpacity: 0.07, dayOpacity: 0.08)
    static let hair2 = Color.look(night: 0xFFFFFF, day: 0x0A0C10, nightOpacity: 0.12, dayOpacity: 0.14)
    static let reply = Color.look(night: 0xD9DBDF, day: 0x2A2E35)
    /// Alive: listening, running, focused.
    static let arc = Color.look(night: 0x8FD8FF, day: 0x0A6CB3)
    static let actionInk = Color.look(night: 0x06121F, day: 0xFFFFFF)
    static let core = Color.look(night: 0xF4FBFF, day: 0x0A3D6B)
    /// Needs you.
    static let brass = Color(hex: 0xE3B76A)
    static let brassText = Color.look(night: 0xE3B76A, day: 0x8A5D10)
    static let brassSurface = Color.look(night: 0x15130F, day: 0xFBF4E6)
    static let brassLine = Color.look(night: 0xE3B76A, day: 0xB07C24, nightOpacity: 0.38, dayOpacity: 0.4)
    static let signal = Color.look(night: 0x7ED6A0, day: 0x1F8A4C)
    static let alert = Color.look(night: 0xFF8A7A, day: 0xC8281E)
    /// The dial's rims: white at night, ink by day.
    static let rim = Color.look(night: 0xFFFFFF, day: 0x0A0C10)
}
