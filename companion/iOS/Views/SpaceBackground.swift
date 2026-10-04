import SwiftUI

/// The night every pane of glass sits on: near-black, lit by the arc reactor from above,
/// with the faintest warmth of Stark gold and hot-rod red low in a corner. The light drifts
/// slowly, so the glass over it always has something to bend. Still with Reduce Motion.
/// (`glow` moves the reactor's light; `grouped` is kept for callers.)
struct SpaceBackground: View {
    var glow: UnitPoint = UnitPoint(x: 0.5, y: 0.3)
    var grouped = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if Look.isObsidian {
            // Obsidian: one flat ground, graphite or porcelain; nothing glows behind it.
            Obsidian.bg
                .ignoresSafeArea()
                .accessibilityHidden(true)
        } else {
            night
        }
    }

    private var night: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: reduceMotion)) { timeline in
            let t = Float(timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3600))
            let gx = Float(glow.x)
            let gy = Float(glow.y)
            ZStack {
                Color(hex: 0x03060D)
                MeshGradient(
                    width: 3, height: 3,
                    points: [
                        [0, 0], [0.5, 0], [1, 0],
                        [0, 0.5], [gx + 0.08 * sin(t * 0.11), gy + 0.06 * cos(t * 0.09)], [1, 0.5 + 0.08 * sin(t * 0.07)],
                        [0, 1], [0.5 + 0.1 * cos(t * 0.05), 1], [1, 1],
                    ],
                    colors: [
                        Color(hex: 0x040B1A), Color(hex: 0x082448), Color(hex: 0x050E20),
                        Color(hex: 0x03070F), Color(hex: 0x0C3F78), Color(hex: 0x040A18),
                        Color(hex: 0x1C0907), Color(hex: 0x03050A), Color(hex: 0x181107),
                    ]
                )
                // A reactor's own light where the orb sits.
                RadialGradient(
                    colors: [Palette.core[2].opacity(0.16), .clear],
                    center: glow, startRadius: 0, endRadius: 260
                )
                // Depth at the bottom, where the controls float.
                LinearGradient(colors: [.clear, .black.opacity(0.45)], startPoint: UnitPoint(x: 0.5, y: 0.6), endPoint: .bottom)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

extension View {
    /// The night behind a screen, through its scroll content (Lists and Forms too).
    func starkBackdrop(glow: UnitPoint = UnitPoint(x: 0.5, y: 0.25)) -> some View {
        scrollContentBackground(.hidden)
            .background(SpaceBackground(glow: glow))
    }
}
