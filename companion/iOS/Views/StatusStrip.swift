import SwiftUI

/// The HUD strip: the Mac's state, model, next event, weather, background tasks, notes.
struct StatusStrip: View {
    let state: MacState?
    let offline: Bool
    let model: String?
    let next: NextEvent?
    let weather: Weather?
    let taskCount: Int
    let meeting: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                stat("Mac", value: stateLabel, color: stateColor) {
                    StateIndicator(state: offline ? nil : state)
                }
                if let meeting {
                    divider
                    stat("Notes", value: meeting, color: Palette.danger) {
                        RecordingDot()
                    }
                }
                if let next, let time = next.date {
                    divider
                    stat("Next", value: "\(time.formatted(date: .omitted, time: .shortened)) · \(next.title)")
                }
                if let weather, weather.isAvailable {
                    divider
                    stat("Weather", value: weather.headline) {
                        Image(systemName: weather.symbol)
                            .symbolRenderingMode(.multicolor)
                            .font(.caption)
                    }
                }
                if taskCount > 0 {
                    divider
                    stat("Tasks", value: "\(taskCount) running") {
                        Image(systemName: "gearshape.2.fill")
                            .font(.caption2)
                            .foregroundStyle(Palette.cyan)
                    }
                }
                divider
                stat("Model", value: model ?? "—")
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 10)
        }
        .edgeFade(leading: 8, trailing: 30)
        .glassCard(cornerRadius: 18)
    }

    private var stateLabel: String {
        if offline { return "Offline" }
        return state?.label ?? "Connecting"
    }

    private var stateColor: Color {
        if offline { return Palette.amber }
        switch state {
        case .idle: return Palette.ink
        case .listening, .thinking, .speaking: return Palette.cyan
        default: return Palette.ink2
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Palette.ring.opacity(0.18))
            .frame(width: 1, height: 26)
    }

    private func stat(_ label: String, value: String, color: Color = Palette.ink) -> some View {
        stat(label, value: value, color: color) { EmptyView() }
    }

    private func stat<Icon: View>(_ label: String, value: String, color: Color = Palette.ink, @ViewBuilder icon: () -> Icon) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HUDText(label)
            HStack(spacing: 5) {
                icon()
                Text(value)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: 220, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
    }
}

/// A small animated mark for the Mac's state: a steady dot when idle, a pulse while
/// listening, a spinning arc while thinking, bars while speaking.
struct StateIndicator: View {
    let state: MacState?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || !(state?.isBusy ?? false))) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            ZStack {
                switch state {
                case .listening:
                    Circle().fill(Palette.cyan.opacity(0.35)).frame(width: 12, height: 12).scaleEffect(0.6 + 0.4 * abs(sin(t * 3)))
                    Circle().fill(Palette.cyan).frame(width: 6, height: 6)
                case .thinking:
                    Circle()
                        .trim(from: 0, to: 0.7)
                        .stroke(Palette.cyan, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                        .frame(width: 10, height: 10)
                        .rotationEffect(.degrees(t * 360))
                case .speaking:
                    HStack(spacing: 1.5) {
                        ForEach(0..<3, id: \.self) { bar in
                            Capsule()
                                .fill(Palette.cyan)
                                .frame(width: 2, height: 3 + 7 * abs(sin(t * 7 + Double(bar) * 1.3)))
                        }
                    }
                case .idle:
                    Circle().fill(Palette.online).frame(width: 7, height: 7)
                        .shadow(color: Palette.online.opacity(0.7), radius: 3)
                default:
                    Circle().fill(state == nil ? Palette.amber : Palette.muted).frame(width: 7, height: 7)
                }
            }
            .frame(width: 12, height: 12)
        }
        .accessibilityHidden(true)
    }
}

private struct RecordingDot: View {
    @State private var on = false

    var body: some View {
        Circle()
            .fill(Palette.danger)
            .frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true }
            }
            .accessibilityHidden(true)
    }
}
