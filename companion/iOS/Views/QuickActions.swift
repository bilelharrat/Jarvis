import SwiftUI

enum QuickAction: Hashable {
    case briefing, whatsNext, notesStart, notesStop, routines, stop
}

/// One tap for the usual things, all in view: brief me, what's next, meeting notes,
/// routines, stop.
struct QuickActions: View {
    let meeting: String?
    let busy: Bool
    let perform: (QuickAction) -> Void

    var body: some View {
        HStack(spacing: 8) {
            tile("Brief me", symbol: "sparkles", action: .briefing)
            tile("What’s next?", symbol: "calendar", action: .whatsNext)
            if meeting == nil {
                tile("Take notes", symbol: "note.text.badge.plus", action: .notesStart)
            } else {
                tile("Stop notes", symbol: "record.circle", action: .notesStop, tint: Palette.danger)
            }
            tile("Routines", symbol: "bolt.fill", action: .routines)
            tile("Stop", symbol: "stop.fill", action: .stop, tint: busy ? Palette.danger : Palette.cyan)
        }
    }

    private func tile(_ title: String, symbol: String, action: QuickAction, tint: Color = Palette.cyan) -> some View {
        Button { perform(action) } label: {
            VStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(tint)
                    .symbolEffect(.pulse, options: .repeating, isActive: action == .notesStop)
                Text(title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(tint == Palette.danger ? Palette.danger : Palette.ink2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 4)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 58)
            .contentShape(Rectangle())
        }
        .buttonStyle(GlassButtonStyle(tint: tint, cornerRadius: 16))
        .accessibilityLabel(title)
    }
}

/// Type instead of talking.
struct InputBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            TextField("", text: $text, prompt: Text("Ask Jarvis…").foregroundStyle(Palette.muted))
                .focused(focused)
                .submitLabel(.send)
                .onSubmit(onSend)
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 18)
                .frame(minHeight: 50)
                .glassCard(cornerRadius: 25, strength: focused.wrappedValue ? 1.8 : 1)
                .accessibilityLabel("Ask Jarvis")

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(canSend ? Palette.space : Palette.muted)
                    .frame(width: 50, height: 50)
                    .background {
                        if canSend {
                            Circle().fill(Palette.action)
                                .shadow(color: Palette.cyan.opacity(0.5), radius: 10)
                        } else {
                            Color.clear.glassCard(cornerRadius: 25, strength: 0.6)
                        }
                    }
            }
            .buttonStyle(PressableStyle())
            .disabled(!canSend)
            .accessibilityLabel("Send to Jarvis")
        }
        .animation(.easeOut(duration: 0.2), value: canSend)
    }

    private var canSend: Bool { !text.trimmed.isEmpty }
}

/// The Mac can't be reached: say so, and how to fix it.
struct ConnectionBanner: View {
    let reason: String
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
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
            Spacer(minLength: 4)
            Button("Retry", action: onRetry)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.cyan)
                .padding(.top, 2)
        }
        .padding(14)
        .glassCard(cornerRadius: 18, tint: Palette.amber)
        .accessibilityElement(children: .combine)
    }
}

/// A short note over the bottom of the screen.
struct ToastView: View {
    let toast: Toast
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
            Text(toast.text)
                .font(.subheadline)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            if toast.opensSettings {
                Spacer(minLength: 4)
                Button("Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.cyan)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .glassCard(cornerRadius: 18, tint: tint)
        .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
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
