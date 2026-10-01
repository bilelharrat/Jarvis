import SwiftUI

/// The canvas behind a screen: the system's grouped background, so a screen sits in the
/// same light as Settings, in light and dark. (`glow` is kept for callers; the canvas has
/// no lighting of its own.)
struct SpaceBackground: View {
    var glow: UnitPoint = UnitPoint(x: 0.5, y: 0.3)
    var grouped = true

    var body: some View {
        (grouped ? Color.systemGroupedBackground : Color.systemBackground)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}
