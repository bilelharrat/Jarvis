import SwiftUI

/// The conversation, the way Apple sets one: what you said in bubbles on the right, Jarvis's
/// answers as plain text on the left, newest at the bottom.
struct TranscriptView: View {
    let lines: [TranscriptLine]
    var onSuggestion: (String) -> Void = { _ in }
    var suggestions: [String] = EmptyTranscript.defaultSuggestions

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.m) {
                if lines.isEmpty {
                    EmptyTranscript(suggestions: suggestions, onSuggestion: onSuggestion)
                }
                ForEach(lines) { line in
                    TranscriptRow(line: line)
                        .id(line.id)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.vertical, Space.s)
            .animation(.spring(response: 0.42, dampingFraction: 0.86), value: lines.map(\.id))
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(lines.isEmpty ? .top : .bottom)
    }
}

struct TranscriptRow: View {
    let line: TranscriptLine

    var body: some View {
        Group {
            switch line.kind {
            case .user: userBubble
            case .jarvis: jarvisReply
            case .problem: problem
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 4) {
                let bubble = UnevenRoundedRectangle(cornerRadii: .init(topLeading: 20, bottomLeading: 20, bottomTrailing: 6, topTrailing: 20), style: .continuous)
                if !line.pictures.isEmpty {
                    SentPictures(pictures: line.pictures)
                        .opacity(line.sending ? 0.7 : 1)
                }
                Text(line.text)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .glassEffect(.regular.tint((line.waiting ? Color.gray : Palette.cyan).opacity(0.35)), in: bubble)
                    .overlay { SpecularRim(shape: bubble, tint: line.waiting ? .white : Palette.ring, strength: 0.7) }
                    .opacity(line.sending ? 0.7 : 1)
                    .textSelection(.enabled)
                if line.waiting {
                    Label("Waiting for your Mac", systemImage: "clock")
                        .font(.caption2)
                        .foregroundStyle(Palette.muted)
                } else if line.sending {
                    Text("Sending…")
                        .font(.caption2)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
    }

    private var jarvisReply: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                OrbMark(size: 12)
                HUDText("Jarvis", color: Palette.ring)
                if line.onPhone {
                    Image(systemName: "iphone")
                        .font(.caption2)
                        .foregroundStyle(Palette.muted)
                        .accessibilityLabel("On this iPhone")
                }
                if let time = line.time, !line.live {
                    Text(time.formatted(date: .omitted, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(Palette.muted)
                }
            }
            if line.live && line.text.isEmpty {
                if line.onHold {
                    Label("Waiting for your OK above", systemImage: "hand.raised.fill")
                        .font(.callout)
                        .foregroundStyle(Palette.champagne)
                } else if let activity = line.activity {
                    HStack(spacing: Space.xs) {
                        ProgressView().controlSize(.small)
                        Text(activity)
                            .font(.callout)
                            .foregroundStyle(Palette.ink2)
                    }
                } else {
                    ThinkingDots()
                        .padding(.vertical, 5)
                }
            } else {
                Text(reply)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .glassCard(cornerRadius: 22)
        .padding(.trailing, 28)
    }

    private var problem: some View {
        Label {
            Text(line.text)
                .font(.callout)
                .foregroundStyle(Palette.ink2)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .symbolRenderingMode(.multicolor)
        }
    }

    /// The reply with a caret while it's still being written.
    private var reply: AttributedString {
        var text = Self.markdown(line.text)
        if line.live {
            var caret = AttributedString(" ●")
            caret.foregroundColor = .accentColor
            text.append(caret)
        }
        return text
    }

    private var accessibilityText: String {
        switch line.kind {
        case .user:
            let pictures = line.pictures.isEmpty ? "" : "With \(line.pictures.count) picture\(line.pictures.count == 1 ? "" : "s"). "
            return line.waiting ? "Waiting for your Mac: \(line.text)" : "\(pictures)You said: \(line.text)"
        case .problem: return line.text
        case .jarvis: return line.text.isEmpty ? (line.onHold ? "Jarvis is waiting for your OK." : "Jarvis is thinking.") : "Jarvis: \(line.text)"
        }
    }

    /// Inline markdown (bold, italics, code, links); line breaks kept.
    static func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct EmptyTranscript: View {
    var suggestions: [String] = Self.defaultSuggestions
    let onSuggestion: (String) -> Void

    static let defaultSuggestions = ["What’s the weather?", "What’s next today?", "Remind me to call Pepper at 5", "Anything urgent in my email?"]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HUDText("Try asking")
                .padding(.leading, 4)
            ForEach(suggestions, id: \.self) { suggestion in
                Button { onSuggestion(suggestion) } label: {
                    HStack {
                        Text(suggestion)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: Space.xs)
                        Image(systemName: "arrow.up.right")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(Palette.cyan)
                    }
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.s)
                    .glassCard(cornerRadius: 18)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(suggestion)
            }
        }
        .padding(.top, Space.xs)
    }
}
