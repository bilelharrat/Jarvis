import SwiftUI

/// What the Mac is doing, as a small animated dot (Settings).
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

/// A short note over the top of the screen.
struct ToastView: View {
    let toast: Toast
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: Space.s - 2) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.body.weight(.semibold))
                .foregroundStyle(tint)
            Text(toast.text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            if toast.opensSettings {
                Spacer(minLength: Space.xxs)
                Button("Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.cyan)
            }
        }
        .padding(.horizontal, Space.m + 2)
        .padding(.vertical, Space.s)
        .surface(.regular, in: Capsule())
        .onTapGesture(perform: onDismiss)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }

    private var symbol: String {
        switch toast.style {
        case .info: "info.circle.fill"
        case .success: "checkmark.circle.fill"
        case .problem: "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch toast.style {
        case .info: Palette.cyan
        case .success: Palette.online
        case .problem: Palette.amber
        }
    }
}
