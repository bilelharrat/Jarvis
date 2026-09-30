import SwiftUI

/// The J.A.R.V.I.S. reactor: the desktop's orb (a lit glass core in two soft halo rings)
/// inside a fine-ticked bezel, like a chronograph's. At rest it only breathes; while Jarvis
/// listens or thinks, a comet of light runs round the bezel and the halo swells with your
/// voice. Purely decorative for VoiceOver; the control around it carries the label.
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
                TimelineView(.animation(minimumInterval: calm ? 1.0 / 30 : 1.0 / 60)) { timeline in
                    ReactorFrame(frame: motion.advance(to: timeline.date, mode: mode, level: level), size: size)
                }
            }
        }
        .frame(width: size, height: size)
        .saturation(mode == .offline ? 0.1 : 1)
        .opacity(mode == .offline ? 0.62 : 1)
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
        let core = s * 0.48
        let bezel = s * 0.94
        let glow = frame.glow
        ZStack {
            // Light the core throws, a little below it (the desktop's "0 30px 90px").
            Circle()
                .fill(RadialGradient(
                    colors: [Palette.cyan.opacity(0.34 * glow), Palette.deep.opacity(0.14 * glow), .clear],
                    center: UnitPoint(x: 0.5, y: 0.55), startRadius: core * 0.2, endRadius: s * 0.5
                ))

            // The bezel: a polished hairline that catches the light at ten and four o'clock,
            // fine ticks, and an inner hairline.
            Circle()
                .strokeBorder(
                    AngularGradient(
                        stops: [
                            .init(color: .white.opacity(0.10), location: 0),
                            .init(color: .white.opacity(0.30), location: 0.125),
                            .init(color: .white.opacity(0.07), location: 0.30),
                            .init(color: .white.opacity(0.09), location: 0.50),
                            .init(color: .white.opacity(0.46), location: 0.625),
                            .init(color: .white.opacity(0.10), location: 0.80),
                            .init(color: .white.opacity(0.10), location: 1),
                        ],
                        center: .center
                    ),
                    lineWidth: max(0.6, s * 0.0045)
                )
                .frame(width: bezel, height: bezel)
            BezelTicks(count: s >= 150 ? 60 : 40, majorEvery: 5)
                .frame(width: bezel * 0.965, height: bezel * 0.965)
                .rotationEffect(.degrees(frame.spin))
            Circle()
                .stroke(Color.white.opacity(0.05), lineWidth: 0.5)
                .frame(width: s * 0.80, height: s * 0.80)

            // The comet: a bright head with a long fading tail, on the bezel.
            if frame.sweep > 0.01 {
                Circle()
                    .trim(from: 0, to: 0.30)
                    .stroke(
                        AngularGradient(
                            stops: [
                                .init(color: Palette.cyan.opacity(0), location: 0),
                                .init(color: Palette.cyan.opacity(0.35), location: 0.18),
                                .init(color: Palette.ice, location: 0.30),
                                .init(color: Palette.ice.opacity(0), location: 0.301),
                            ],
                            center: .center
                        ),
                        style: StrokeStyle(lineWidth: max(1.5, s * 0.011), lineCap: .round)
                    )
                    .frame(width: bezel * 0.965, height: bezel * 0.965)
                    .rotationEffect(.degrees(frame.arc))
                    .shadow(color: Palette.cyan.opacity(0.9), radius: s * 0.018)
                    .opacity(frame.sweep)
            }

            // Halo rings: the desktop orb's two soft rings, swelling with your voice. Each is a
            // lens of light, brightest by the core, with a fine edge.
            HaloRing(diameter: core * frame.outerRing, core: core, strength: 0.07 * glow)
            HaloRing(diameter: core * frame.innerRing, core: core, strength: 0.13 * glow)

            if frame.ripple > 0 {
                Circle()
                    .stroke(Palette.ice.opacity(0.45 * (1 - frame.ripple)), lineWidth: max(0.75, s * 0.005))
                    .frame(width: core * (1 + 0.9 * frame.ripple), height: core * (1 + 0.9 * frame.ripple))
            }

            // The core: lit glass.
            ZStack {
                Circle()
                    .fill(RadialGradient(
                        stops: [
                            .init(color: Palette.core[0], location: 0),
                            .init(color: Palette.core[1], location: 0.16),
                            .init(color: Palette.core[2], location: 0.44),
                            .init(color: Palette.core[3], location: 0.72),
                            .init(color: Palette.core[4], location: 1),
                        ],
                        center: UnitPoint(x: 0.36, y: 0.32), startRadius: 0, endRadius: core * 0.93
                    ))
                // The desktop's sheen, turning while it works.
                Circle()
                    .fill(AngularGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .clear, location: 0.62),
                            .init(color: .white.opacity(0.55), location: 0.82),
                            .init(color: .clear, location: 1),
                        ],
                        center: .center
                    ))
                    .rotationEffect(.degrees(frame.arc * 0.6))
                    .blendMode(.softLight)
                    .opacity(frame.sweep)
                // A specular glint, and a rim of light round the glass.
                Ellipse()
                    .fill(RadialGradient(colors: [.white.opacity(0.75), .white.opacity(0)], center: .center, startRadius: 0, endRadius: core * 0.16))
                    .frame(width: core * 0.36, height: core * 0.24)
                    .offset(x: -core * 0.15, y: -core * 0.22)
                    .blendMode(.screen)
                Circle()
                    .strokeBorder(
                        LinearGradient(colors: [.white.opacity(0.55), .white.opacity(0.0), Palette.ice.opacity(0.25)], startPoint: .top, endPoint: .bottom),
                        lineWidth: max(0.5, core * 0.008)
                    )
            }
            .frame(width: core, height: core)
            .shadow(color: Palette.cyan.opacity(min(0.85, 0.55 * glow)), radius: core * 0.16)
            .scaleEffect(frame.breath)
        }
        .frame(width: s, height: s)
        .drawingGroup()
    }
}

/// One of the halo's rings: light falling off from the core outwards, and a hairline rim.
private struct HaloRing: View {
    let diameter: CGFloat
    let core: CGFloat
    let strength: Double

    var body: some View {
        Circle()
            .fill(RadialGradient(
                colors: [Palette.ring.opacity(strength * 1.5), Palette.ring.opacity(strength * 0.55)],
                center: .center, startRadius: core * 0.45, endRadius: diameter / 2
            ))
            .overlay(Circle().strokeBorder(Palette.ice.opacity(min(0.2, strength * 1.1)), lineWidth: 0.5))
            .frame(width: diameter, height: diameter)
    }
}

/// Fine ticks round a dial; every `majorEvery`th is longer and brighter.
private struct BezelTicks: View {
    let count: Int
    let majorEvery: Int

    var body: some View {
        Canvas { context, size in
            let radius = min(size.width, size.height) / 2
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let minor = max(2, radius * 0.035)
            let major = max(3.5, radius * 0.07)
            for index in 0..<count {
                let isMajor = index % majorEvery == 0
                let angle = Double(index) / Double(count) * 2 * .pi
                let length = isMajor ? major : minor
                let outer = CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius)
                let inner = CGPoint(x: center.x + cos(angle) * (radius - length), y: center.y + sin(angle) * (radius - length))
                var path = Path()
                path.move(to: outer)
                path.addLine(to: inner)
                context.stroke(
                    path,
                    with: .color(Palette.ice.opacity(isMajor ? 0.42 : 0.16)),
                    style: StrokeStyle(lineWidth: isMajor ? 1 : 0.6, lineCap: .round)
                )
            }
        }
    }
}

/// Integrates the reactor's motion frame by frame, so a change of pace (idle to thinking)
/// eases instead of jumping.
final class ReactorMotion {
    struct Frame {
        var spin = 0.0
        var arc = 0.0
        var breath = 1.0
        var glow = 0.85
        var ripple = 0.0
        /// How much of the comet and sheen shows, 0...1.
        var sweep = 0.0
        /// The halo rings' diameters, in core diameters (the desktop's +18 px and +40 px).
        var innerRing = 1.36
        var outerRing = 1.72

        static func still(_ mode: ReactorView.Mode) -> Frame {
            let goal = Goal.for(mode)
            // Still, the comet parks at ten o'clock so a busy reactor still reads as busy.
            return Frame(spin: 0, arc: -150, breath: 1, glow: goal.glow, ripple: 0, sweep: goal.sweep)
        }
    }

    struct Goal {
        var spin: Double  // degrees a second (the bezel)
        var arc: Double  // degrees a second (the comet)
        var breath: Double  // breaths a second
        var amplitude: Double
        var glow: Double
        var sweep: Double

        static func `for`(_ mode: ReactorView.Mode) -> Goal {
            switch mode {
            case .idle: Goal(spin: 0, arc: 40, breath: 0.2, amplitude: 0.022, glow: 0.85, sweep: 0)
            case .listening: Goal(spin: 4, arc: 120, breath: 0.8, amplitude: 0.014, glow: 1, sweep: 1)
            case .thinking: Goal(spin: 10, arc: 260, breath: 0.6, amplitude: 0.02, glow: 0.95, sweep: 1)
            case .speaking: Goal(spin: 4, arc: 70, breath: 0.55, amplitude: 0.04, glow: 1.05, sweep: 0.55)
            case .offline: Goal(spin: 0, arc: 0, breath: 0.12, amplitude: 0.008, glow: 0.35, sweep: 0)
            }
        }
    }

    private var last: Date?
    private var spin = 0.0
    private var arc = -150.0
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
        pace.sweep += (goal.sweep - pace.sweep) * min(1, dt * 3.5)
        level += (max(0, min(1, target)) - level) * min(1, dt * 14)

        spin = (spin + pace.spin * dt).truncatingRemainder(dividingBy: 360)
        arc = (arc + pace.arc * dt).truncatingRemainder(dividingBy: 360)
        breathPhase = (breathPhase + pace.breath * dt * 2 * .pi).truncatingRemainder(dividingBy: 2 * .pi)
        let rippling = mode == .listening || mode == .speaking
        ripplePhase = rippling ? (ripplePhase + dt / 1.8).truncatingRemainder(dividingBy: 1) : 0

        let listening = mode == .listening ? level : 0
        let wave = sin(breathPhase)
        return Frame(
            spin: spin,
            arc: arc,
            breath: 1 + pace.amplitude * wave + listening * 0.12,
            glow: pace.glow + listening * 0.35,
            ripple: rippling ? max(ripplePhase, 0.001) : 0,
            sweep: max(0, min(1, pace.sweep)),
            innerRing: 1.36 + listening * 0.22 + pace.amplitude * 1.5 * wave,
            outerRing: 1.72 + listening * 0.34 + pace.amplitude * 2.5 * wave
        )
    }
}
