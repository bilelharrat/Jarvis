import SwiftUI

/// A Claude question in Eden Code, answered the way the Mac's window can: one option, several
/// at once ("pick"), or in your own words ("other").
struct QuestionCard: View {
    let approval: Approval
    /// choice and its feedback: ("opt2", ""), ("pick", "{\"picked\":[0,2]}"), ("other", "words").
    let onAnswer: (String, String) -> Void

    @State private var picked: Set<Int> = []
    @State private var own = ""
    @FocusState private var typing: Bool

    private var canPick: Bool { approval.freeChoices.contains("pick") }
    private var canSay: Bool { approval.freeChoices.contains("other") }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.xs) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(Palette.champagne)
                Eyebrow("Eden Code asks", color: Palette.champagne)
            }
            Text(approval.question)
                .font(.serifHeadline)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button {
                    if approval.multi && canPick {
                        if picked.contains(index) { picked.remove(index) } else { picked.insert(index) }
                    } else {
                        onAnswer("opt\(index)", "")
                    }
                } label: {
                    HStack(alignment: .top, spacing: Space.s) {
                        if approval.multi && canPick {
                            Image(systemName: picked.contains(index) ? "checkmark.square.fill" : "square")
                                .foregroundStyle(picked.contains(index) ? Palette.cyan : Palette.muted)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).font(.body.weight(.medium)).foregroundStyle(Palette.ink)
                            if !option.description.isEmpty {
                                Text(option.description).font(.footnote).foregroundStyle(Palette.ink2)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(Space.s)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.06)))
                }
                .buttonStyle(.plain)
            }
            if approval.multi && canPick {
                Button("Answer with \(picked.count) Selected") {
                    onAnswer("pick", Self.picks(picked.sorted(), own: ""))
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(picked.isEmpty)
            }
            if canSay {
                HStack(spacing: Space.xs) {
                    TextField("Or say it in your own words", text: $own, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($typing)
                    Button("Send") { onAnswer("other", own.trimmed) }
                        .disabled(own.trimmed.isEmpty)
                }
                .padding(Space.s)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
            }
            Button("Skip") { onAnswer("skip", "") }
                .font(.footnote)
                .foregroundStyle(Palette.muted)
        }
        .padding(Space.m)
        .glassCard(cornerRadius: Radius.card)
    }

    /// The options: the card's own, or the choices' labels for an older Mac.
    private var options: [ApprovalOption] {
        if !approval.options.isEmpty { return approval.options }
        return approval.choices.filter { $0.id.hasPrefix("opt") }.map { ApprovalOption(label: $0.label) }
    }

    /// What "pick" carries: the options' indexes, and any words of the owner's own.
    static func picks(_ indexes: [Int], own: String) -> String {
        var body: [String: JSONValue] = ["picked": .array(indexes.map { .int($0) })]
        if !own.isEmpty { body["other"] = .string(own) }
        return (try? JSONValue.object(body).encoded()).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

/// The session's slash commands: Eden Code's own, and the project's and yours.
struct CodeCommandsView: View {
    let sessionID: Int
    let onPick: (String) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var items: [(name: String, help: String)]?
    @State private var query = ""

    static let builtIn: [(name: String, help: String)] = [
        ("/plan", "Plan first: read and propose before changing anything"),
        ("/review", "Review the changes so far"),
        ("/diff", "What changed in this session"),
        ("/undo", "Take back the last change"),
        ("/compact", "Shorten the conversation to free up context"),
        ("/clear", "Start the conversation over in this session"),
        ("/init", "Write a CLAUDE.md for this project"),
    ]

    var body: some View {
        let all = Self.builtIn + (items ?? [])
        let shown = query.trimmed.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.help.localizedCaseInsensitiveContains(query) }
        List(Array(shown.enumerated()), id: \.offset) { _, item in
            Button {
                onPick(item.name)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(.body.monospaced()).foregroundStyle(Palette.ink)
                    if !item.help.isEmpty { Text(item.help).font(.footnote).foregroundStyle(Palette.muted) }
                }
            }
        }
        .searchable(text: $query, prompt: "Find a command")
        .navigationTitle("Commands")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        let result = try? await api.codeAction("commands", session: sessionID, timeout: 20)
        items = (result?["slash_list"]?["items"]?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue, !name.isEmpty else { return nil }
            return (name.hasPrefix("/") ? name : "/" + name, item["help"]?.stringValue ?? "")
        }
    }
}
