import SwiftUI

/// Jarvis's reactor: a glass sphere of moving light (a mesh of reactor blues under a
/// highlight) inside a fine-ticked bezel, like a chronograph's, with Stark gold at the
/// quarters. At rest it barely breathes; listening, it swells with your voice and a comet of
/// light runs round the bezel; thinking, the light turns faster; speaking, it pulses.
/// Offline it goes quiet and grey.
/// Purely decorative for VoiceOver; the control around it carries the label.
struct ReactorView: View {
    enum Mode: Equatable, Sendable {
        case idle, listening, thinking, speaking, offline
    }

    var mode: Mode
    /// Microphone level, 0...1, while listening.
    var level: Double = 0
    var size: CGFloat = 200

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var dimmed
    @State private var motion = OrbMotion()

    var body: some View {
        Group {
            if reduceMotion || dimmed {
                OrbFrame(state: .still(mode), size: size)
            } else {
                TimelineView(.animation(minimumInterval: calm ? 1.0 / 30 : 1.0 / 60)) { timeline in
                    OrbFrame(state: motion.advance(to: timeline.date, mode: mode, level: level), size: size)
                }
            }
        }
        .frame(width: size, height: size)
        .saturation(mode == .offline ? 0 : 1)
        .opacity(mode == .offline ? 0.55 : 1)
        .animation(.easeInOut(duration: 0.6), value: mode == .offline)
        .accessibilityHidden(true)
    }

    private var calm: Bool { mode == .idle || mode == .offline }
}

private struct OrbFrame: View {
    let state: OrbMotion.State
    let size: CGFloat

    var body: some View {
        let t = Float(state.time)
        let swirl = Float(state.swirl)
        let scale = 0.86 + 0.14 * state.swell
        ZStack {
            Bezel(size: size, sweep: state.sweep, lit: state.comet)
            // The light it throws around itself.
            Circle()
                .fill(RadialGradient(
                    colors: [Palette.core[3].opacity(0.42 * state.glow), Palette.core[4].opacity(0.16 * state.glow), .clear],
                    center: .center, startRadius: size * 0.2, endRadius: size * 0.5
                ))
                .blur(radius: size * 0.04)

            // The sphere: a 3×3 mesh whose inner points drift, so its light moves inside it.
            MeshGradient(
                width: 3, height: 3,
                points: [
                    [0, 0], [0.5, 0], [1, 0],
                    [0, 0.5 + 0.12 * sin(t * 0.9 + swirl)], [0.5 + 0.22 * sin(t * 1.3 + swirl), 0.5 + 0.22 * cos(t * 1.1 + swirl)], [1, 0.5 + 0.12 * cos(t * 0.8 + swirl)],
                    [0, 1], [0.5 + 0.1 * cos(t * 0.7), 1], [1, 1],
                ],
                colors: [
                    Palette.core[1], Palette.core[2], Palette.core[4],
                    Palette.core[2], Palette.core[0], Palette.core[3],
                    Palette.core[4], Palette.core[3], Palette.core[2],
                ]
            )
            .clipShape(Circle())
            .overlay(
                // Glass: a highlight up and to the left, depth toward the bottom.
                Circle().fill(RadialGradient(colors: [.white.opacity(0.55), .white.opacity(0)], center: UnitPoint(x: 0.33, y: 0.26), startRadius: 0, endRadius: size * 0.32))
            )
            .overlay(
                Circle().fill(RadialGradient(colors: [.clear, .black.opacity(0.18)], center: UnitPoint(x: 0.5, y: 0.4), startRadius: size * 0.2, endRadius: size * 0.42))
            )
            .overlay(Circle().strokeBorder(.white.opacity(0.35), lineWidth: max(0.5, size * 0.004)))
            .frame(width: size * 0.62, height: size * 0.62)
            .scaleEffect(scale)
            .shadow(color: Palette.core[3].opacity(0.35 * state.glow), radius: size * 0.08, y: size * 0.03)
        }
    }
}

/// Eases the orb toward each mode's look, so changes flow instead of jumping.
private final class OrbMotion {
    struct State {
        var time: Double
        var swell: Double
        var glow: Double
        var swirl: Double
        /// Where the comet is on the bezel, in turns.
        var sweep: Double = 0
        /// How bright the comet is (0 at rest).
        var comet: Double = 0

        static func still(_ mode: ReactorView.Mode) -> State {
            let goal = Goal.for(mode)
            return State(time: 0, swell: goal.swell, glow: goal.glow, swirl: 0, sweep: 0.12, comet: goal.comet)
        }
    }

    struct Goal {
        var swell: Double
        var glow: Double
        /// How fast the light inside turns.
        var speed: Double
        /// Breathing depth.
        var breathe: Double
        /// The bezel's comet: brightness and turns per second.
        var comet: Double
        var orbit: Double

        static func `for`(_ mode: ReactorView.Mode) -> Goal {
            switch mode {
            case .idle: Goal(swell: 0.55, glow: 0.55, speed: 0.6, breathe: 0.05, comet: 0.25, orbit: 0.04)
            case .listening: Goal(swell: 0.7, glow: 1, speed: 1.1, breathe: 0.02, comet: 1, orbit: 0.35)
            case .thinking: Goal(swell: 0.62, glow: 0.85, speed: 2.6, breathe: 0.04, comet: 1, orbit: 0.8)
            case .speaking: Goal(swell: 0.72, glow: 0.95, speed: 1.4, breathe: 0.12, comet: 0.7, orbit: 0.25)
            case .offline: Goal(swell: 0.45, glow: 0.2, speed: 0.2, breathe: 0.0, comet: 0, orbit: 0)
            }
        }
    }

    private var last: Date?
    private var state = State(time: 0, swell: 0.55, glow: 0.5, swirl: 0)
    private var heard = 0.0

    func advance(to date: Date, mode: ReactorView.Mode, level target: Double) -> State {
        let dt = min(0.1, last.map { date.timeIntervalSince($0) } ?? 0)
        last = date
        let goal = Goal.for(mode)
        let k = 1 - exp(-dt * 5)
        heard += ((mode == .listening ? target : 0) - heard) * (1 - exp(-dt * 14))
        state.time += dt * goal.speed
        state.swirl += dt * goal.speed * 0.4
        let breath = sin(date.timeIntervalSinceReferenceDate * (mode == .speaking ? 5.5 : 1.6)) * goal.breathe
        state.swell += (goal.swell + breath + heard * 0.35 - state.swell) * k
        state.glow += (goal.glow + heard * 0.3 - state.glow) * k
        state.comet += (goal.comet - state.comet) * k
        state.sweep += dt * goal.orbit
        return state
    }
}

/// The bezel: a glass ring with sixty fine ticks (every fifth longer), Stark gold at the
/// quarters, and a comet of reactor light running round it.
private struct Bezel: View {
    let size: CGFloat
    let sweep: Double
    let lit: Double

    var body: some View {
        let ring = size * 0.92
        ZStack {
            Circle()
                .strokeBorder(
                    LinearGradient(colors: [.white.opacity(0.32), .white.opacity(0.05), .white.opacity(0.14)], startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: max(0.6, size * 0.004)
                )
                .frame(width: ring, height: ring)
            Canvas { context, canvas in
                let center = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
                let outer = canvas.width / 2 - size * 0.02
                for tick in 0..<60 {
                    let angle = Double(tick) / 60 * 2 * .pi - .pi / 2
                    let quarter = tick % 15 == 0
                    let major = tick % 5 == 0
                    let length = size * (quarter ? 0.045 : major ? 0.03 : 0.016)
                    var path = Path()
                    path.move(to: CGPoint(x: center.x + cos(angle) * outer, y: center.y + sin(angle) * outer))
                    path.addLine(to: CGPoint(x: center.x + cos(angle) * (outer - length), y: center.y + sin(angle) * (outer - length)))
                    let color = quarter ? Palette.champagne.opacity(0.85) : Color.white.opacity(major ? 0.38 : 0.16)
                    context.stroke(path, with: .color(color), lineWidth: quarter ? max(1, size * 0.008) : max(0.5, size * 0.004))
                }
            }
            .frame(width: ring, height: ring)
            // The comet: a short arc of reactor light, brightest at its head.
            Circle()
                .trim(from: 0, to: 0.22)
                .stroke(
                    AngularGradient(colors: [Palette.ring.opacity(0), Palette.ring.opacity(0.9 * lit), Palette.ice.opacity(lit)], center: .center, startAngle: .degrees(0), endAngle: .degrees(79)),
                    style: StrokeStyle(lineWidth: max(1.2, size * 0.01), lineCap: .round)
                )
                .frame(width: ring - size * 0.01, height: ring - size * 0.01)
                .rotationEffect(.degrees(sweep * 360 - 90))
                .shadow(color: Palette.ring.opacity(0.8 * lit), radius: size * 0.02)
                .opacity(lit > 0.01 ? 1 : 0)
        }
        .allowsHitTesting(false)
    }
}
