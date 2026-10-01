import SwiftUI
import UIKit

/// A reply in Markdown, laid out the way the Claude, ChatGPT and Gemini apps do: headings,
/// paragraphs, bulleted and numbered lists, quotes, tables, and fenced code blocks in a
/// monospaced card with a Copy button. Inline styling (bold, italics, code, links) inside each.
struct RichText: View {
    let text: String
    var caret = false

    var body: some View {
        let blocks = MarkdownBlocks.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                view(for: block, last: index == blocks.count - 1)
            }
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlocks.Block, last: Bool) -> some View {
        switch block {
        case .heading(let level, let words):
            Text(inline(words, caret: last && caret))
                .font(level <= 1 ? .title3.weight(.bold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .foregroundStyle(Palette.ink)
        case .paragraph(let words):
            Text(inline(words, caret: last && caret))
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineSpacing(3)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { number, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(number + 1)." : "•")
                            .font(.body.monospacedDigit())
                            .foregroundStyle(Palette.ice)
                        Text(inline(item, caret: last && caret && number == items.count - 1))
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                    }
                }
            }
        case .quote(let words):
            Text(inline(words))
                .font(.body.italic())
                .foregroundStyle(Palette.ink2)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Palette.ice.opacity(0.6)).frame(width: 3) }
        case .code(let language, let code):
            CodeBlock(language: language, code: code)
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows)
        case .rule:
            Divider()
        }
    }

    private func inline(_ words: String, caret: Bool = false) -> AttributedString {
        var text = TranscriptRow.markdown(words)
        if caret {
            var mark = AttributedString(" ●")
            mark.foregroundColor = .accentColor
            text.append(mark)
        }
        return text
    }
}

/// Code, monospaced, scrolling sideways, with its language and a Copy button.
struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption.monospaced())
                    .foregroundStyle(Palette.muted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Haptics.tap()
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy the code")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            Divider()
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.75))
    }
}

/// A Markdown table as a grid that scrolls sideways when it's wide.
struct TableBlock: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(TranscriptRow.markdown(cell)).font(.footnote.weight(.semibold)).foregroundStyle(Palette.ink)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<header.count, id: \.self) { column in
                            Text(TranscriptRow.markdown(column < row.count ? row[column] : ""))
                                .font(.footnote)
                                .foregroundStyle(Palette.ink)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Markdown split into the blocks RichText lays out (no HTML, nothing nested past one level).
enum MarkdownBlocks {
    enum Block: Equatable {
        case heading(Int, String)
        case paragraph(String)
        case list([String], ordered: Bool)
        case quote(String)
        case code(String, String)
        case table([String], [[String]])
        case rule
    }

    static func parse(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var list: [String] = []
        var ordered = false
        var lines = text.components(separatedBy: "\n")[...]

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }
        func flushList() {
            if !list.isEmpty { blocks.append(.list(list, ordered: ordered)) }
            list = []
        }
        func flush() { flushParagraph(); flushList() }

        while let line = lines.popFirst() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                while let next = lines.popFirst() {
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                    code.append(next)
                }
                blocks.append(.code(language, code.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
            } else if let level = heading(trimmed) {
                flush()
                blocks.append(.heading(level, String(trimmed.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces)))
            } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix("|"), let next = lines.first, isDivider(next) {
                flush()
                lines.removeFirst()
                var rows: [[String]] = []
                while let row = lines.first, row.trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(row))
                    lines.removeFirst()
                }
                blocks.append(.table(cells(trimmed), rows))
            } else if trimmed.hasPrefix("> ") {
                flush()
                blocks.append(.quote(String(trimmed.dropFirst(2))))
            } else if let item = bullet(trimmed) {
                flushParagraph()
                if !list.isEmpty && ordered { flushList() }
                ordered = false
                list.append(item)
            } else if let item = numbered(trimmed) {
                flushParagraph()
                if !list.isEmpty && !ordered { flushList() }
                ordered = true
                list.append(item)
            } else {
                flushList()
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private static func bullet(_ line: String) -> String? {
        for mark in ["- ", "* ", "• "] where line.hasPrefix(mark) { return String(line.dropFirst(mark.count)) }
        return nil
    }

    private static func numbered(_ line: String) -> String? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return String(rest.dropFirst(2))
    }

    private static func isDivider(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.contains("-") && trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|") { row.removeLast() }
        return row.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
