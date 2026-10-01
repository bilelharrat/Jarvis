import SwiftUI

/// Jarvis's orb: a sphere of soft, moving light (a mesh of Jarvis blues drifting under a
/// glass highlight). At rest it barely breathes; listening, it swells with your voice;
/// thinking, its light turns; speaking, it pulses. Offline it goes quiet and grey.
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

        static func still(_ mode: ReactorView.Mode) -> State {
            let goal = Goal.for(mode)
            return State(time: 0, swell: goal.swell, glow: goal.glow, swirl: 0)
        }
    }

    struct Goal {
        var swell: Double
        var glow: Double
        /// How fast the light inside turns.
        var speed: Double
        /// Breathing depth.
        var breathe: Double

        static func `for`(_ mode: ReactorView.Mode) -> Goal {
            switch mode {
            case .idle: Goal(swell: 0.55, glow: 0.55, speed: 0.6, breathe: 0.05)
            case .listening: Goal(swell: 0.7, glow: 1, speed: 1.1, breathe: 0.02)
            case .thinking: Goal(swell: 0.62, glow: 0.85, speed: 2.6, breathe: 0.04)
            case .speaking: Goal(swell: 0.72, glow: 0.95, speed: 1.4, breathe: 0.12)
            case .offline: Goal(swell: 0.45, glow: 0.2, speed: 0.2, breathe: 0.0)
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
        return state
    }
}
