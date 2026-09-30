import SwiftUI

/// The night behind everything: obsidian, lit softly by the reactor, a cool wash from above
/// and a little depth at the bottom, with the faintest dust of stars.
struct SpaceBackground: View {
    var glow: UnitPoint = UnitPoint(x: 0.5, y: 0.3)

    var body: some View {
        ZStack {
            Palette.space
            // The reactor's light on the room.
            RadialGradient(
                colors: [Palette.deep.opacity(0.30), Palette.deep.opacity(0.08), .clear],
                center: glow, startRadius: 0, endRadius: 460
            )
            // Cool light from above, like the desktop's glass wash.
            RadialGradient(
                colors: [Palette.cyan.opacity(0.07), .clear],
                center: UnitPoint(x: 0.1, y: -0.08), startRadius: 0, endRadius: 520
            )
            // Depth where the controls sit.
            LinearGradient(colors: [.clear, Color(hex: 0x0A1426).opacity(0.55)], startPoint: UnitPoint(x: 0.5, y: 0.55), endPoint: .bottom)
            StarDust()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private struct StarDust: View {
    var body: some View {
        Canvas { context, size in
            var random = SplitMix(seed: 0x4A_52_56_53)
            for _ in 0..<46 {
                let x = random.unit() * size.width
                let y = random.unit() * size.height
                let radius = 0.25 + random.unit() * 0.6
                let alpha = 0.04 + random.unit() * 0.18
                let rect = CGRect(x: x, y: y, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: rect), with: .color(Palette.ice.opacity(alpha)))
            }
        }
        .allowsHitTesting(false)
    }
}

/// A tiny deterministic generator, so the stars stay put between redraws.
private struct SplitMix {
    var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}

/// Keeps scrolled content from colliding with the status bar: the night, fading down.
/// Put it over a scroll view in a ZStack that respects the safe area.
struct TopScrim: View {
    var body: some View {
        GeometryReader { geometry in
            let top = geometry.safeAreaInsets.top
            let height = top + Space.xl
            // Solid (blurred and dimmed) under the status bar, then a soft edge below it.
            let edge = LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: top / height * 0.85),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            VStack(spacing: 0) {
                ZStack {
                    Rectangle().fill(.ultraThinMaterial)
                    Palette.space.opacity(0.88)
                }
                .mask(edge)
                .frame(height: height)
                Spacer(minLength: 0)
            }
            .ignoresSafeArea(edges: .top)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
