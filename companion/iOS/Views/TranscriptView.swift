import SwiftUI

/// The conversation, the way Apple sets one: what you said in bubbles on the right, Jarvis's
/// answers as plain text on the left, newest at the bottom.
struct TranscriptView: View {
    let lines: [TranscriptLine]
    var onSuggestion: (String) -> Void = { _ in }
    var suggestions: [String] = EmptyTranscript.defaultSuggestions
    /// A long press's choice on a line (copy and share are done here).
    var onAction: (LineAction, TranscriptLine) -> Void = { _, _ in }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.m) {
                if lines.isEmpty {
                    EmptyTranscript(suggestions: suggestions, onSuggestion: onSuggestion)
                }
                let lastUser = lines.last { $0.kind == .user }?.id
                let lastReply = lines.last { $0.kind == .jarvis }?.id
                ForEach(lines) { line in
                    TranscriptRow(
                        line: line,
                        canRegenerate: line.onPhone && line.id == lastReply && !line.live,
                        canEdit: line.onPhone && line.id == lastUser,
                        onAction: { onAction($0, line) }
                    )
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
    var canRegenerate = false
    var canEdit = false
    var onAction: (LineAction) -> Void = { _ in }

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
        .accessibilityActions {
            if line.offersUpgrade { Button("Upgrade to Jarvis Plus") { onAction(.upgrade) } }
        }
    }

    /// Copy, share, read aloud; on Jarvis's last reply here, try again and feedback; on
    /// the last question, edit it.
    @ViewBuilder
    private var menu: some View {
        Button("Copy", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = line.text
            Haptics.tap()
        }
        ShareLink(item: line.text) { Label("Share", systemImage: "square.and.arrow.up") }
        Button("Read Aloud", systemImage: "speaker.wave.2") { onAction(.readAloud) }
        if canEdit {
            Button("Edit", systemImage: "pencil") { onAction(.edit) }
        }
        if line.kind == .jarvis {
            if canRegenerate {
                Button("Try Again", systemImage: "arrow.clockwise") { onAction(.regenerate) }
            }
            Button("Good Response", systemImage: "hand.thumbsup") { onAction(.good) }
            Button("Bad Response", systemImage: "hand.thumbsdown") { onAction(.bad) }
        }
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
                ForEach(line.files, id: \.self) { name in
                    DocumentChip(name: name)
                }
                Text(line.text)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .surface(.regular.tint((line.waiting ? Color.gray : Palette.cyan).opacity(0.35)), in: bubble, fill: line.waiting ? Obsidian.raised : Obsidian.arc.opacity(0.16))
                    .overlay { SpecularRim(shape: bubble, tint: line.waiting ? .white : Palette.ring, strength: 0.7) }
                    .opacity(line.sending ? 0.7 : 1)
                    .contentShape(.contextMenuPreview, bubble)
                    .contextMenu { if !line.text.isEmpty { menu } }
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
                RichText(text: line.text, caret: line.live)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let note = line.note {
                Label(note, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .glassCard(cornerRadius: 22)
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 22, style: .continuous))
        .contextMenu { if !line.text.isEmpty && !line.live { menu } }
        .padding(.trailing, 28)
    }

    private var problem: some View {
        Label {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(line.text)
                    .font(.callout)
                    .foregroundStyle(Palette.ink2)
                if line.offersUpgrade {
                    Button("Upgrade to Jarvis Plus") { onAction(.upgrade) }
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, Space.s)
                        .padding(.vertical, 6)
                        .buttonStyle(GlassButtonStyle(tint: .accentColor))
                }
            }
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .symbolRenderingMode(.multicolor)
        }
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
