import SwiftUI
import UIKit

/// Puts the chosen look (Look.swift) on the whole app: Stark Glass keeps every window dark,
/// Obsidian follows the iPhone's appearance. Changing it rebuilds the app's views, so every
/// colour and surface is drawn again in the new look.
struct LookRoot: ViewModifier {
    @AppStorage(Look.key) private var raw = Look.starkGlass.rawValue

    func body(content: Content) -> some View {
        let look = Look(rawValue: raw) ?? .starkGlass
        // Before anything below is drawn, so Palette and the shared views read the new look.
        let _ = Look.current = look
        content
            .id(look)
            .tint(look == .obsidian ? Obsidian.arc : nil)
            .preferredColorScheme(look == .obsidian ? nil : .dark)
            .onChange(of: raw, initial: true) { Self.style(windowsFor: look) }
    }

    /// Every window, sheets and alerts included: dark for Stark Glass, the system's for Obsidian.
    @MainActor
    static func style(windowsFor look: Look) {
        let style: UIUserInterfaceStyle = look == .obsidian ? .unspecified : .dark
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { window.overrideUserInterfaceStyle = style }
        }
    }
}

extension View {
    func chosenLook() -> some View { modifier(LookRoot()) }
}
