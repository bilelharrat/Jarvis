import SwiftUI

enum QuickAction: Hashable {
    case briefing, whatsNext, notesStart, notesStop, routines, stop
}

/// One tap for the usual things, all in view: brief me, what's next, meeting notes,
/// routines, stop. Round glass keys with a label beneath, like Control Center's.
struct QuickActions: View {
    let meeting: String?
    let busy: Bool
    let perform: (QuickAction) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            key("Brief me", symbol: "sparkles", action: .briefing)
            key("What’s next?", symbol: "calendar", action: .whatsNext)
            if meeting == nil {
                key("Take notes", symbol: "note.text", action: .notesStart)
            } else {
                key("Stop notes", symbol: "record.circle", action: .notesStop, tint: Palette.danger)
            }
            key("Routines", symbol: "bolt.fill", action: .routines)
            key("Stop", symbol: "stop.fill", action: .stop, tint: busy ? Palette.danger : nil)
        }
    }

    private func key(_ title: String, symbol: String, action: QuickAction, tint: Color? = nil) -> some View {
        Button { perform(action) } label: {
            QuickKey(title: title, symbol: symbol, tint: tint, pulsing: action == .notesStop)
        }
        .buttonStyle(PressableStyle())
        .frame(maxWidth: .infinity)
        .accessibilityLabel(title)
    }
}

private struct QuickKey: View {
    let title: String
    let symbol: String
    let tint: Color?
    let pulsing: Bool

    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 54
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: min(diameter, 70) * 0.36, weight: .medium))
                .foregroundStyle(tint ?? Palette.ink)
                .symbolEffect(.pulse, options: .repeating, isActive: pulsing && !reduceMotion)
                .frame(width: min(diameter, 70), height: min(diameter, 70))
                .glass(Circle(), tint: tint ?? .white, strength: tint == nil ? 1 : 1.3)
            Text(title)
                .font(.caption2.weight(.medium))
                .foregroundStyle(tint ?? Palette.ink2)
                .multilineTextAlignment(.center)
                // At the largest sizes a label takes two lines rather than an ellipsis.
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 1)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
    }
}

/// Type instead of talking: one glass capsule, the send key inside it.
struct InputBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            TextField("", text: $text, prompt: Text("Ask Jarvis…").foregroundStyle(Palette.muted))
                .focused(focused)
                .submitLabel(.send)
                .onSubmit(onSend)
                .foregroundStyle(Palette.ink)
                .tint(Palette.cyan)
                .padding(.leading, Space.m + 4)
                .padding(.vertical, Space.s)
                .accessibilityLabel("Ask Jarvis")

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(canSend ? Palette.onAction : Palette.muted)
                    .frame(width: 36, height: 36)
                    .background {
                        if canSend {
                            Circle().fill(Palette.action)
                                .overlay(Circle().strokeBorder(.white.opacity(0.45), lineWidth: 0.5))
                                .shadow(color: Palette.cyan.opacity(0.5), radius: 8)
                        } else {
                            Circle().fill(Color.white.opacity(0.07))
                        }
                    }
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(PressableStyle())
            .disabled(!canSend)
            .padding(.trailing, 4)
            .accessibilityLabel("Send to Jarvis")
        }
        .frame(minHeight: 52)
        .glass(Capsule(), tint: focused.wrappedValue ? Palette.cyan : .white, strength: focused.wrappedValue ? 0.6 : 1)
        .animation(.easeOut(duration: 0.2), value: canSend)
        .animation(.easeOut(duration: 0.2), value: focused.wrappedValue)
    }

    private var canSend: Bool { !text.trimmed.isEmpty }
}

/// The Mac can't be reached: say so, and how to fix it.
struct ConnectionBanner: View {
    let reason: String
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Image(systemName: "wifi.exclamationmark")
                .symbolRenderingMode(.hierarchical)
                .font(.title3)
                .foregroundStyle(Palette.amber)
            VStack(alignment: .leading, spacing: 3) {
                Text("Can’t reach the Mac")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.xxs)
            Button("Retry", action: onRetry)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, Space.s)
                .padding(.vertical, 6)
                .glass(Capsule(), strength: 1.2)
                .buttonStyle(PressableStyle())
        }
        .padding(Space.m - 2)
        .glassCard(cornerRadius: 20, tint: Palette.amber, strength: 0.8)
        .accessibilityElement(children: .combine)
    }
}

/// A short note over the bottom of the screen.
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
        .background {
            // A floating layer: dense, neutral glass (the symbol carries the colour), so the
            // conversation beneath doesn't read through it.
            let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
            shape.fill(.regularMaterial)
                .overlay(shape.fill(Palette.spaceRaised.opacity(0.72)))
                .overlay(shape.strokeBorder(
                    LinearGradient(colors: [.white.opacity(0.22), .white.opacity(0.05)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.75
                ))
        }
        .shadow(color: .black.opacity(0.5), radius: 24, y: 10)
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
