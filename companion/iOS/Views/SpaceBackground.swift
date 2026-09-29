import SwiftUI

/// Deep space behind everything: #060b16, a soft reactor glow and a few faint stars.
struct SpaceBackground: View {
    var glow: UnitPoint = UnitPoint(x: 0.5, y: 0.3)

    var body: some View {
        ZStack {
            Palette.space
            RadialGradient(
                colors: [Palette.cyan.opacity(0.17), Palette.deep.opacity(0.06), .clear],
                center: glow, startRadius: 8, endRadius: 440
            )
            RadialGradient(
                colors: [Palette.deep.opacity(0.16), .clear],
                center: UnitPoint(x: 0.5, y: 1.15), startRadius: 0, endRadius: 420
            )
            StarField()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private struct StarField: View {
    var body: some View {
        Canvas { context, size in
            var random = SplitMix(seed: 0x4A_52_56_53)
            for _ in 0..<110 {
                let x = random.unit() * size.width
                let y = random.unit() * size.height
                let radius = 0.3 + random.unit() * 0.9
                let alpha = 0.08 + random.unit() * 0.4
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
