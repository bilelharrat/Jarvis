import SwiftUI

/// Obsidian's reactor (the Mac's web/obsidian.js, line for line): a fine-ticked dial in the
/// orb's place. Idle, a still bezel with brass at the quarters and a faint light going round;
/// listening, the ticks follow your voice; thinking, a bright bump sweeps the ticks and an arc
/// the inner ring; speaking, the ring lights and the ticks pulse. Offline it goes still and
/// grey. One still frame a state with Reduce Motion. Decorative for VoiceOver.
struct ObsidianDial: View {
    var mode: ReactorView.Mode
    /// Microphone level, 0...1, while listening.
    var level: Double = 0
    var size: CGFloat = 200

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var dimmed
    private let start = Date()

    var body: some View {
        Group {
            if reduceMotion || dimmed {
                DialFrame(state: DialGeometry.State(mode), t: 0, level: 0)
            } else {
                // At rest the light moves slowly: twenty frames a second is plenty.
                TimelineView(.animation(minimumInterval: DialGeometry.State(mode).isLive ? 1.0 / 60 : 1.0 / 20)) { timeline in
                    DialFrame(state: DialGeometry.State(mode), t: timeline.date.timeIntervalSince(start), level: level)
                }
            }
        }
        .frame(width: size, height: size)
        .saturation(mode == .offline ? 0 : 1)
        .opacity(mode == .offline ? 0.55 : 1)
        .animation(.easeInOut(duration: 0.6), value: mode == .offline)
        .accessibilityHidden(true)
    }
}

/// The dial's geometry, pure (tests check it against the Mac's): drawn in a 420-unit square.
enum DialGeometry {
    static let dial: Double = 420
    static let ticks = 144
    static let tickRadius: Double = 166  // where the ticks start; they grow outward
    static let ringRadius: Double = 136

    enum State: Equatable {
        case idle, listening, thinking, speaking

        init(_ mode: ReactorView.Mode) {
            switch mode {
            case .listening: self = .listening
            case .thinking: self = .thinking
            case .speaking: self = .speaking
            case .idle, .offline: self = .idle
            }
        }

        var isLive: Bool { self != .idle }
    }

    static func isMajor(_ i: Int) -> Bool { i % 12 == 0 }

    /// The tick the thinking bump has reached: once round in three seconds.
    static func sweepHead(_ t: Double) -> Int { Int((t * 48).truncatingRemainder(dividingBy: Double(ticks))) }

    /// How long tick i is (dial units) in a state, t seconds in, at a voice level of 0...1.
    static func tickLength(_ i: Int, _ state: State, _ t: Double, _ level: Double) -> Double {
        let lv = max(0, min(1, level))
        let x = Double(i)
        switch state {
        case .listening:
            let w = abs(sin(x * 0.31 + t * 2.1) * cos(x * 0.087 - t * 1.3 + 0.9))
            return 4 + (8 + 34 * lv) * pow(w, 1.3)
        case .speaking:
            let envelope = 0.55 + 0.45 * cos(x * 0.131 + t * 1.7)
            let energy = 0.7 + 0.3 * sin(t * 9) * sin(t * 3.3)
            return 4 + 18 * abs(sin(x * 0.5 + t * 7)) * envelope * energy
        case .thinking:
            let d = ((i - sweepHead(t)) % ticks + ticks) % ticks
            return d < 32 ? 5 + 11 * sin(Double(d) / 32 * .pi) : 4
        case .idle:
            return isMajor(i) ? 12 : 5
        }
    }

    /// Whether tick i is bright: the twelve hour marks at rest (and the slow light going
    /// round), the long ones while it's live.
    static func tickBright(_ i: Int, _ state: State, _ length: Double, _ t: Double) -> Bool {
        switch state {
        case .thinking: return length > 7
        case .listening, .speaking: return length > 13
        case .idle:
            if isMajor(i) { return true }
            let head = (t / 24 * Double(ticks)).truncatingRemainder(dividingBy: Double(ticks))
            let d = (head - Double(i)).truncatingRemainder(dividingBy: Double(ticks))
            return (d < 0 ? d + Double(ticks) : d) < 6
        }
    }

    /// The inner ring's light: opacity, start angle and sweep in radians from twelve o'clock.
    static func ring(_ state: State, _ t: Double) -> (opacity: Double, start: Double, sweep: Double) {
        let full = Double.pi * 2
        switch state {
        case .thinking: return (0.95, (t * 2.6).truncatingRemainder(dividingBy: full), full * 0.22)
        case .speaking: return (0.55, 0, full)
        case .listening: return (0.3, 0, full)
        case .idle: return (0, 0, 0)
        }
    }
}

/// One frame of the dial.
private struct DialFrame: View {
    let state: DialGeometry.State
    let t: Double
    let level: Double

    var body: some View {
        Canvas { context, canvasSize in
            let side = min(canvasSize.width, canvasSize.height)
            let k = side / DialGeometry.dial
            let live = state.isLive
            context.translateBy(x: canvasSize.width / 2, y: canvasSize.height / 2)
            context.scaleBy(x: k, y: k)

            func circle(_ r: Double) -> Path {
                Path(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2))
            }

            context.stroke(circle(204), with: .color(Obsidian.rim.opacity(0.06)), lineWidth: 1)

            // the ticks, dim and bright, each group in one path
            var dim = Path()
            var bright = Path()
            for i in 0..<DialGeometry.ticks {
                let a = Double(i) / Double(DialGeometry.ticks) * .pi * 2 - .pi / 2
                let length = DialGeometry.tickLength(i, state, t, level)
                let from = CGPoint(x: cos(a) * DialGeometry.tickRadius, y: sin(a) * DialGeometry.tickRadius)
                let to = CGPoint(x: cos(a) * (DialGeometry.tickRadius + length), y: sin(a) * (DialGeometry.tickRadius + length))
                if DialGeometry.tickBright(i, state, length, t) {
                    bright.move(to: from); bright.addLine(to: to)
                } else {
                    dim.move(to: from); dim.addLine(to: to)
                }
            }
            context.stroke(dim, with: .color(Obsidian.arc.opacity(0.34)), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
            context.drawLayer { layer in
                layer.addFilter(.shadow(color: Obsidian.arc.opacity(live ? 0.7 : 0.4), radius: (live ? 10 : 6) / 2))
                layer.stroke(bright, with: .color(Obsidian.arc.opacity(0.92)), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
            }

            // brass at the quarters, as on a chronograph's bezel
            var quarters = Path()
            for q in 0..<4 {
                let a = Double(q) * .pi / 2 - .pi / 2
                quarters.move(to: CGPoint(x: cos(a) * 197, y: sin(a) * 197))
                quarters.addLine(to: CGPoint(x: cos(a) * 205, y: sin(a) * 205))
            }
            context.stroke(quarters, with: .color(Obsidian.brass), style: StrokeStyle(lineWidth: 2.2, lineCap: .round))

            context.stroke(circle(DialGeometry.ringRadius), with: .color(Obsidian.rim.opacity(0.09)), lineWidth: 1)
            let ring = DialGeometry.ring(state, t)
            if ring.opacity > 0 {
                var arc = Path()
                arc.addArc(
                    center: .zero, radius: DialGeometry.ringRadius,
                    startAngle: .radians(ring.start - .pi / 2), endAngle: .radians(ring.start - .pi / 2 + ring.sweep),
                    clockwise: false
                )
                context.drawLayer { layer in
                    layer.addFilter(.shadow(color: Obsidian.arc.opacity(0.6), radius: 4))
                    layer.stroke(arc, with: .color(Obsidian.arc.opacity(ring.opacity)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                }
            }
            context.stroke(circle(104), with: .color(Obsidian.rim.opacity(0.07)), style: StrokeStyle(lineWidth: 1, dash: [1.5, 7]))

            // the core: two soft discs, a fine ring and a bright point
            let lv = max(0, min(1, level))
            context.fill(circle(72), with: .color(Obsidian.arc.opacity(live ? 0.08 : 0.04)))
            context.fill(circle(50), with: .color(Obsidian.arc.opacity((live ? 0.12 : 0.07) + lv * 0.08)))
            context.drawLayer { layer in
                layer.addFilter(.shadow(color: Obsidian.arc.opacity(0.55), radius: 6))
                layer.stroke(circle(30 + lv * 4), with: .color(Obsidian.arc), lineWidth: 1.6)
            }
            context.fill(circle(5), with: .color(Obsidian.core))
        }
    }
}
