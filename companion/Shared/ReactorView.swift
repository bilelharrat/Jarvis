import SwiftUI

/// The J.A.R.V.I.S. reactor: a breathing core inside a dashed cyan ring that spins while
/// Jarvis listens or thinks. Purely decorative for VoiceOver; the control around it
/// carries the label.
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
    @State private var motion = ReactorMotion()

    var body: some View {
        Group {
            if reduceMotion || dimmed {
                ReactorFrame(frame: .still(mode), size: size)
            } else {
                TimelineView(.animation(minimumInterval: calm ? 1.0 / 24 : 1.0 / 60)) { timeline in
                    ReactorFrame(frame: motion.advance(to: timeline.date, mode: mode, level: level), size: size)
                }
            }
        }
        .frame(width: size, height: size)
        .saturation(mode == .offline ? 0.12 : 1)
        .opacity(mode == .offline ? 0.6 : 1)
        .animation(.easeInOut(duration: 0.6), value: mode == .offline)
        .accessibilityHidden(true)
    }

    private var calm: Bool { mode == .idle || mode == .offline }
}

private struct ReactorFrame: View {
    let frame: ReactorMotion.Frame
    let size: CGFloat

    var body: some View {
        let s = size
        let ringDiameter = s * 0.86
        let period = Double.pi * ringDiameter / 48
        ZStack {
            // Halo
            Circle()
                .fill(RadialGradient(
                    colors: [Palette.cyan.opacity(0.40 * frame.glow), Palette.deep.opacity(0.16 * frame.glow), .clear],
                    center: .center, startRadius: s * 0.16, endRadius: s * 0.5
                ))
            Circle()
                .stroke(Palette.ring.opacity(0.16), lineWidth: 1)
                .frame(width: s * 0.97, height: s * 0.97)
            // The dashed ring
            Circle()
                .stroke(Palette.ring.opacity(0.9), style: StrokeStyle(lineWidth: max(1.5, s * 0.022), dash: [period * 0.52, period * 0.48]))
                .frame(width: ringDiameter, height: ringDiameter)
                .rotationEffect(.degrees(frame.spin))
                .shadow(color: Palette.ring.opacity(0.6), radius: s * 0.018)
            // Two bright arcs, turning the other way
            arc(offset: 0)
            arc(offset: 180)
            Circle()
                .stroke(Palette.ring.opacity(0.28), lineWidth: 1)
                .frame(width: s * 0.66, height: s * 0.66)
            if frame.ripple > 0 {
                Circle()
                    .stroke(Palette.cyan.opacity(0.6 * (1 - frame.ripple)), lineWidth: max(1, s * 0.008))
                    .frame(width: s * (0.5 + 0.34 * frame.ripple), height: s * (0.5 + 0.34 * frame.ripple))
            }
            // The core
            Circle()
                .fill(RadialGradient(
                    stops: [
                        .init(color: Palette.core[0], location: 0),
                        .init(color: Palette.core[1], location: 0.16),
                        .init(color: Palette.core[2], location: 0.44),
                        .init(color: Palette.core[3], location: 0.72),
                        .init(color: Palette.core[4], location: 1),
                    ],
                    center: UnitPoint(x: 0.36, y: 0.32), startRadius: 0, endRadius: s * 0.5 * 0.93
                ))
                .frame(width: s * 0.5, height: s * 0.5)
                .shadow(color: Palette.cyan.opacity(min(0.9, 0.6 * frame.glow)), radius: s * 0.07)
                .scaleEffect(frame.breath)
        }
        .frame(width: s, height: s)
        .drawingGroup()
    }

    private func arc(offset: Double) -> some View {
        Circle()
            .trim(from: 0, to: 0.13)
            .stroke(Palette.ice, style: StrokeStyle(lineWidth: max(1.5, size * 0.014), lineCap: .round))
            .frame(width: size * 0.74, height: size * 0.74)
            .rotationEffect(.degrees(frame.arc + offset))
            .shadow(color: Palette.cyan.opacity(0.9), radius: size * 0.02)
    }
}

/// Integrates the reactor's motion frame by frame, so a change of pace (idle to thinking)
/// eases instead of jumping.
final class ReactorMotion {
    struct Frame {
        var spin = 0.0
        var arc = 0.0
        var breath = 1.0
        var glow = 0.8
        var ripple = 0.0

        static func still(_ mode: ReactorView.Mode) -> Frame {
            Frame(spin: 0, arc: 0, breath: 1, glow: Goal.for(mode).glow, ripple: 0)
        }
    }

    struct Goal {
        var spin: Double  // degrees a second
        var arc: Double
        var breath: Double  // breaths a second
        var amplitude: Double
        var glow: Double

        static func `for`(_ mode: ReactorView.Mode) -> Goal {
            switch mode {
            case .idle: Goal(spin: 0, arc: 9, breath: 0.28, amplitude: 0.025, glow: 0.8)
            case .listening: Goal(spin: 80, arc: -140, breath: 0.9, amplitude: 0.02, glow: 1)
            case .thinking: Goal(spin: 150, arc: -240, breath: 0.8, amplitude: 0.035, glow: 0.95)
            case .speaking: Goal(spin: 30, arc: -60, breath: 1.6, amplitude: 0.05, glow: 1.05)
            case .offline: Goal(spin: 0, arc: 0, breath: 0.15, amplitude: 0.01, glow: 0.35)
            }
        }
    }

    private var last: Date?
    private var spin = 0.0
    private var arc = 0.0
    private var breathPhase = 0.0
    private var ripplePhase = 0.0
    private var pace = Goal.for(.idle)
    private var level = 0.0

    func advance(to date: Date, mode: ReactorView.Mode, level target: Double) -> Frame {
        let dt = min(max(date.timeIntervalSince(last ?? date), 0), 0.1)
        last = date
        let goal = Goal.for(mode)
        let ease = min(1, dt * 2.5)
        pace.spin += (goal.spin - pace.spin) * ease
        pace.arc += (goal.arc - pace.arc) * ease
        pace.breath += (goal.breath - pace.breath) * ease
        pace.amplitude += (goal.amplitude - pace.amplitude) * ease
        pace.glow += (goal.glow - pace.glow) * ease
        level += (max(0, min(1, target)) - level) * min(1, dt * 14)

        spin = (spin + pace.spin * dt).truncatingRemainder(dividingBy: 360)
        arc = (arc + pace.arc * dt).truncatingRemainder(dividingBy: 360)
        breathPhase = (breathPhase + pace.breath * dt * 2 * .pi).truncatingRemainder(dividingBy: 2 * .pi)
        let rippling = mode == .listening || mode == .speaking
        ripplePhase = rippling ? (ripplePhase + dt / 1.6).truncatingRemainder(dividingBy: 1) : 0

        let listening = mode == .listening ? level : 0
        return Frame(
            spin: spin,
            arc: arc,
            breath: 1 + pace.amplitude * sin(breathPhase) + listening * 0.16,
            glow: pace.glow + listening * 0.35,
            ripple: rippling ? max(ripplePhase, 0.001) : 0
        )
    }
}
