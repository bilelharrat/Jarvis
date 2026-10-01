import SwiftUI

/// Voice mode: a spoken conversation, hands free (AppModel's voice mode). The orb listens,
/// thinks and speaks; talking over Jarvis (or tapping the orb) cuts it short.
struct VoiceModeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: Space.l) {
            VStack(spacing: 4) {
                Text("Voice Mode").font(.headline).foregroundStyle(Palette.ink)
                Text(model.answererLabel).font(.footnote).foregroundStyle(Palette.muted)
            }
            .padding(.top, Space.l)
            Spacer()
            Button(action: model.voiceModeTap) {
                ReactorView(mode: model.reactorMode, level: model.speech.level, size: 280)
            }
            .buttonStyle(OrbButtonStyle())
            .accessibilityLabel(hint)
            Text(words)
                .font(.title3.weight(.semibold))
                .foregroundStyle(model.speech.isActive && model.speech.transcript.isEmpty ? Palette.muted : Palette.ink)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .padding(.horizontal, Space.l)
                .contentTransition(.opacity)
                .animation(.smooth, value: words)
            Text(hint)
                .font(.footnote)
                .foregroundStyle(Palette.muted)
            Spacer()
            Button {
                model.endVoiceMode()
            } label: {
                Image(systemName: "xmark")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
            }
            .glassEffect(.regular.tint(.red).interactive(), in: Circle())
            .accessibilityLabel("End voice mode")
            .padding(.bottom, Space.l)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.45)))
        .statusBarHidden()
    }

    /// What's heard while listening; the reply while it's said.
    private var words: String {
        switch model.reactorMode {
        case .listening: return model.speech.transcript.isEmpty ? "Listening…" : model.speech.transcript
        case .thinking: return model.brain.turns.last(where: { $0.live })?.text.nilIfEmpty ?? "Thinking…"
        case .speaking: return Self.tail(model.transcript.last(where: { $0.kind == .jarvis })?.text ?? "")
        default: return ""
        }
    }

    private var hint: String {
        switch model.reactorMode {
        case .listening: return "Tap to send now"
        case .speaking, .thinking: return "Talk or tap to interrupt"
        default: return "Tap to talk"
        }
    }

    /// The last few lines of a long reply (what's being said is near the end).
    static func tail(_ text: String) -> String {
        let sentences = text.split(whereSeparator: { ".!?\n".contains($0) })
        return sentences.suffix(2).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ". ")
    }
}
