import SwiftUI

/// The conversation: You / JARVIS, newest at the bottom, fading out at the top edge.
struct TranscriptView: View {
    let lines: [TranscriptLine]
    var onSuggestion: (String) -> Void = { _ in }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if lines.isEmpty {
                        EmptyTranscript(onSuggestion: onSuggestion)
                    }
                    ForEach(lines) { line in
                        TranscriptRow(line: line)
                            .id(line.id)
                            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.top, 18)
                .padding(.bottom, 10)
                .animation(.spring(response: 0.45, dampingFraction: 0.85), value: lines.map(\.id))
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: lines.last) { _, _ in
                withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo(Self.bottom, anchor: .bottom) }
        }
        .mask(
            LinearGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: 0.07),
                .init(color: .black, location: 0.96),
                .init(color: .clear, location: 1),
            ], startPoint: .top, endPoint: .bottom)
        )
    }

    private static let bottom = "transcript-bottom"
}

struct TranscriptRow: View {
    let line: TranscriptLine

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Capsule()
                .fill(barStyle)
                .frame(width: 2)
                .padding(.vertical, 2)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    HUDText(label, color: labelColor)
                    if let time = line.time {
                        Text(time.formatted(date: .omitted, time: .shortened))
                            .font(.hud)
                            .foregroundStyle(Palette.muted.opacity(0.7))
                    }
                    if line.sending {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(Palette.muted)
                    }
                }
                content
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var content: some View {
        switch line.kind {
        case .user:
            Text(line.text)
                .font(.callout)
                .foregroundStyle(Palette.ink2)
                .textSelection(.enabled)
        case .problem:
            Text(line.text)
                .font(.callout)
                .foregroundStyle(Palette.amber)
        case .jarvis:
            if line.live && line.text.isEmpty {
                if line.onHold {
                    Label("Waiting for your OK above", systemImage: "hand.raised.fill")
                        .font(.callout)
                        .foregroundStyle(Palette.amber)
                } else {
                    ThinkingDots()
                        .padding(.vertical, 4)
                }
            } else {
                Text(reply)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(3)
                    .textSelection(.enabled)
            }
        }
    }

    /// The reply with a cyan caret while it's still being written.
    private var reply: AttributedString {
        var text = Self.markdown(line.text)
        if line.live {
            var caret = AttributedString(" ▍")
            caret.foregroundColor = Palette.cyan
            text.append(caret)
        }
        return text
    }

    private var label: String {
        switch line.kind {
        case .user: "You"
        case .jarvis: "Jarvis"
        case .problem: "Not sent"
        }
    }

    private var labelColor: Color {
        switch line.kind {
        case .user: Palette.muted
        case .jarvis: Palette.cyan
        case .problem: Palette.amber
        }
    }

    private var barStyle: AnyShapeStyle {
        switch line.kind {
        case .user: AnyShapeStyle(Palette.muted.opacity(0.35))
        case .jarvis: AnyShapeStyle(LinearGradient(colors: [Palette.cyan, Palette.deep.opacity(0.4)], startPoint: .top, endPoint: .bottom))
        case .problem: AnyShapeStyle(Palette.amber.opacity(0.7))
        }
    }

    private var accessibilityText: String {
        switch line.kind {
        case .user: "You said: \(line.text)"
        case .problem: line.text
        case .jarvis: line.text.isEmpty ? (line.onHold ? "Jarvis is waiting for your OK." : "Jarvis is thinking.") : "Jarvis: \(line.text)"
        }
    }

    /// Inline markdown (bold, italics, code, links); line breaks kept.
    static func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct EmptyTranscript: View {
    let onSuggestion: (String) -> Void
    private let suggestions = ["What’s the weather?", "Anything urgent in my email?", "Remind me to call Pepper at 5"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HUDText("Ready when you are", color: Palette.cyan)
            Text("Tap the reactor and talk, or type below. Replies come from Jarvis on your Mac.")
                .font(.callout)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button { onSuggestion(suggestion) } label: {
                        Label(suggestion, systemImage: "arrow.up.right")
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(GlassButtonStyle(cornerRadius: 12))
                }
            }
        }
        .padding(.vertical, 8)
    }
}
