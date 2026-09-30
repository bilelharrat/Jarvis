import SwiftUI

/// A shelf of small glass modules, like Weather's: the Mac's state, meeting notes, the next
/// event, the weather, background tasks, the model. It runs the full width of the screen
/// and scrolls sideways, so a module that doesn't fit peeks in from the edge.
struct StatusStrip: View {
    let state: MacState?
    let offline: Bool
    let model: String?
    let next: NextEvent?
    let weather: Weather?
    let taskCount: Int
    let meeting: String?
    /// Jarvis Code sessions working or waiting on the owner.
    var code: [CodeSessionSummary] = []
    var onCode: () -> Void = {}

    /// The widest module (the next event), growing with Dynamic Type up to most of a screen.
    @ScaledMetric(relativeTo: .subheadline) private var wide: CGFloat = 240

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.xs) {
                stat("Mac", value: stateLabel, color: stateColor) {
                    StateIndicator(state: offline ? nil : state)
                }
                if !code.isEmpty {
                    let needsYou = code.filter { $0.status == .needsYou }.count
                    Button(action: onCode) {
                        stat("Jarvis Code", value: needsYou > 0 ? (needsYou == 1 ? "Needs you" : "\(needsYou) need you") : "\(code.count) working",
                             color: needsYou > 0 ? Palette.champagne : Palette.ice, tint: needsYou > 0 ? Palette.champagne : .white) {
                            Image(systemName: needsYou > 0 ? "hand.raised.fill" : "chevron.left.forwardslash.chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(needsYou > 0 ? Palette.champagne : Palette.ice)
                        }
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityHint("Opens Jarvis Code")
                }
                if let meeting {
                    stat("Notes", value: meeting, color: Palette.danger, tint: Palette.danger) {
                        RecordingDot()
                    }
                }
                if let next, let time = next.date {
                    stat("Next", value: next.title, detail: time.formatted(date: .omitted, time: .shortened), maxWidth: min(wide, 330))
                }
                if let weather, weather.isAvailable {
                    stat("Weather", value: weather.headline) {
                        Image(systemName: weather.symbol)
                            .symbolRenderingMode(.multicolor)
                            .font(.footnote)
                    }
                }
                if taskCount > 0, code.isEmpty {  // the same sessions, when the Mac lists them itself
                    stat("Tasks", value: "\(taskCount) running") {
                        Image(systemName: "gearshape.2.fill")
                            .symbolRenderingMode(.hierarchical)
                            .font(.caption)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                if let model, !model.isEmpty {
                    stat("Model", value: model)
                }
            }
            .padding(.vertical, 1)  // keeps the rims inside the clip
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()  // the glass's shadow falls outside; the shelf is full-width anyway
        .contentMargins(.horizontal, Space.m + 4, for: .scrollContent)
    }

    private var stateLabel: String {
        if offline { return "Offline" }
        return state?.label ?? "Connecting"
    }

    private var stateColor: Color {
        if offline { return Palette.amber }
        switch state {
        case .idle: return Palette.ink
        case .listening, .thinking, .speaking: return Palette.ice
        default: return Palette.ink2
        }
    }

    private func stat(_ label: String, value: String, detail: String? = nil, color: Color = Palette.ink, maxWidth: CGFloat = 220) -> some View {
        stat(label, value: value, detail: detail, color: color, maxWidth: maxWidth) { EmptyView() }
    }

    /// One module: a small label (with a detail beside it, like an event's time, the way a
    /// calendar widget sets it), then the value.
    private func stat<Icon: View>(
        _ label: String, value: String, detail: String? = nil, color: Color = Palette.ink,
        tint: Color = .white, maxWidth: CGFloat = 220, @ViewBuilder icon: () -> Icon
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Eyebrow(label)
                if let detail {
                    Text(detail)
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Palette.ice)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            HStack(spacing: 6) {
                icon()
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
        }
        .padding(.horizontal, Space.m - 2)
        .padding(.vertical, Space.s - 2)
        .frame(maxWidth: maxWidth, alignment: .leading)
        .glassCard(cornerRadius: Radius.control + 2, tint: tint, strength: tint == .white ? 1 : 0.5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \([detail, value].compactMap { $0 }.joined(separator: " · "))")
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
                    Circle().fill(Palette.ice).frame(width: 6, height: 6)
                case .thinking:
                    Circle()
                        .trim(from: 0, to: 0.7)
                        .stroke(Palette.ice, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                        .frame(width: 10, height: 10)
                        .rotationEffect(.degrees(t * 360))
                case .speaking:
                    HStack(spacing: 1.5) {
                        ForEach(0..<3, id: \.self) { bar in
                            Capsule()
                                .fill(Palette.ice)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(Palette.danger)
            .frame(width: 7, height: 7)
            .opacity(on || reduceMotion ? 1 : 0.35)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true }
            }
            .accessibilityHidden(true)
    }
}
