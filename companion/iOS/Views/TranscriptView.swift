import SwiftUI

/// The conversation: You / Jarvis, newest at the bottom, fading out at the top edge.
/// Jarvis speaks in New York; you in SF Pro. Runs the full width of the screen and brings
/// its own margins, so the suggestion shelf can bleed off the edges.
struct TranscriptView: View {
    let lines: [TranscriptLine]
    var onSuggestion: (String) -> Void = { _ in }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l - 2) {
                if lines.isEmpty {
                    EmptyTranscript(onSuggestion: onSuggestion)
                }
                ForEach(lines) { line in
                    TranscriptRow(line: line)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, Space.l)  // the page margin plus a little; the view itself runs edge to edge
            .padding(.top, Space.l)
            .padding(.bottom, Space.xs)
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: lines.map(\.id))
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        // Newest at the bottom, and it stays there as lines arrive and the room changes (an
        // approval, the keyboard). The empty state reads from the top.
        .defaultScrollAnchor(lines.isEmpty ? .top : .bottom)
        // Soft edges, a steady depth however tall it is (but never eating a short one), and
        // nothing drawn outside.
        .mask {
            GeometryReader { geometry in
                VStack(spacing: 0) {
                    // Eased, so a line cut by the edge is gone rather than half there.
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black.opacity(0.25), location: 0.5),
                            .init(color: .black, location: 1),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                    .frame(height: min(Space.xl, geometry.size.height * 0.3))
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: min(Space.xs, geometry.size.height * 0.05))
                }
            }
        }
        .clipped()
        // A mask whose frame springs along with the layout can stick at its old size and hide
        // the lines (an approval arriving shrinks this view), so this view's own frame snaps;
        // the lines inside still fade in with their own animation.
        .transaction { $0.animation = nil }
    }
}

struct TranscriptRow: View {
    let line: TranscriptLine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                marker
                Eyebrow(label, color: labelColor)
                if let time = line.time {
                    Text(time.formatted(date: .omitted, time: .shortened))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Palette.muted.opacity(0.75))
                }
                if line.sending {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Palette.muted)
                }
            }
            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var marker: some View {
        switch line.kind {
        case .jarvis:
            OrbMark(size: 9)
        case .user:
            Circle()
                .strokeBorder(Palette.muted.opacity(0.8), lineWidth: 1)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
        case .problem:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(Palette.amber)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch line.kind {
        case .user:
            Text(line.text)
                .font(.callout)
                .foregroundStyle(Palette.ink2)
                .lineSpacing(2)
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
                        .foregroundStyle(Palette.champagne)
                } else {
                    ThinkingDots(color: Palette.ice)
                        .padding(.vertical, 5)
                }
            } else {
                Text(reply)
                    .font(.voice)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(4)
                    .textSelection(.enabled)
            }
        }
    }

    /// The reply with a reactor-blue caret while it's still being written.
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
        case .jarvis: Palette.ice.opacity(0.9)
        case .problem: Palette.amber
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
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: Space.xxs + 2) {
                Text("Ready when you are.")
                    .font(.serifTitle)
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Tap the reactor and talk, or type below.")
                    .font(.callout)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // One row that scrolls sideways, bleeding to the screen's edges like a shelf.
            ScrollView(.horizontal) {
                HStack(spacing: Space.xs) {
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button { onSuggestion(suggestion) } label: {
                            HStack(spacing: 6) {
                                Text(suggestion)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Palette.ink)
                                    .lineLimit(1)
                                Image(systemName: "arrow.up.right")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(Palette.cyan)
                            }
                            .padding(.horizontal, Space.m - 2)
                            .frame(minHeight: 40)
                            .glass(Capsule())
                        }
                        .buttonStyle(PressableStyle())
                        .accessibilityLabel(suggestion)
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            .contentMargins(.horizontal, Space.l, for: .scrollContent)
            .padding(.horizontal, -Space.l)
        }
        .padding(.vertical, Space.xxs)
    }
}
