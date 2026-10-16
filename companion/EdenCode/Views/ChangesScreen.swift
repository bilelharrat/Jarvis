import SwiftUI

/// What a session changed (PhoneChanges mockup): Turn or Session, the turn's receipt, each
/// file's hunks with Keep, Undo and a comment on a line (a tap on the line), Read aloud,
/// and Undo all / Open pull request at the bottom.
struct ChangesScreen: View {
    let id: Int
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var view = "turn"
    @State private var changes: PhoneChanges?
    @State private var receipt: PhoneReceipt?
    @State private var problem: String?
    @State private var said: String?
    @State private var busy = false
    @State private var commenting: CommentTarget?
    @State private var confirmUndoAll = false
    private let speaker = Speaker.shared

    struct CommentTarget: Identifiable {
        var path: String
        var line: PhoneChanges.Line
        var id: String { "\(path):\(line.index)" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if let problem { ProblemBanner(text: problem) }
                if let said { Text(said).font(.system(size: 13)).foregroundStyle(EdenTheme.muted).padding(.horizontal, 4) }
                if let receipt { ReceiptCard(receipt: receipt) }
                if let changes {
                    if changes.files.isEmpty {
                        Text(changes.git ? "No changes in this view." : "This folder isn’t a git repository.")
                            .font(.subheadline).foregroundStyle(EdenTheme.muted)
                            .frame(maxWidth: .infinity).padding(24).edenCard(radius: 20)
                    }
                    ForEach(changes.files) { file in
                        FileCard(file: file, busy: busy, speaking: speaker.speaking == "f\(file.path)",
                                 onKeep: { hunk in act([hunk.id], hunk.kept ? "unkeep" : "keep") },
                                 onUndo: { hunk in act([hunk.id], "undo") },
                                 onComment: { line in commenting = CommentTarget(path: file.path, line: line) },
                                 onRead: { speaker.toggle(Speaker.spoken(file: file), id: "f\(file.path)") })
                    }
                } else if problem == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 90)
        }
        .scrollDismissesKeyboard(.interactively)
        .statusBarScrim()
        .background(EdenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom) { footer }
        .task(id: view) { await load() }
        .sheet(item: $commenting) { target in
            CommentSheet(target: target) { text in
                Task { await comment(target, text) }
            }
            .presentationDetents([.height(260)])
        }
        .confirmationDialog("Undo every change in this view that you haven’t kept?", isPresented: $confirmUndoAll, titleVisibility: .visible) {
            Button("Undo all", role: .destructive) { act(changes?.unkeptHunks ?? [], "undo") }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 16, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                    .frame(width: 36, height: 36)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to session")
            Text("Changes").font(.system(size: 22, weight: .bold)).foregroundStyle(EdenTheme.ink).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Picker("Which changes", selection: $view) {
                Text("Turn").tag("turn")
                Text("Session").tag("session")
            }
            .pickerStyle(.segmented)
            .frame(width: 150)
        }
        .padding(.top, 8)
    }

    private var footer: some View {
        TwoButtons(ratio: 1.4) {
            Button { confirmUndoAll = true } label: {
                Text("Undo all").font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .glassEffect(.regular.interactive(), in: .capsule)
            }
            .buttonStyle(.plain)
            .disabled(busy || (changes?.unkeptHunks.isEmpty ?? true))
        } second: {
            Button { openPR() } label: {
                Text("Open pull request").font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.onInk)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(EdenTheme.ink, in: .capsule)
            }
            .buttonStyle(PressScale(scale: 0.97))
            .disabled(busy || (changes?.files.isEmpty ?? true))
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
    }

    private func load() async {
        guard let backend = store.backend else { return }
        do {
            async let found = backend.changes(id: id, view: view)
            async let receipts = try? backend.receipts(id: id)
            changes = try await found
            receipt = await receipts?.receipts.last
            problem = nil
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func act(_ hunks: [String], _ action: String) {
        guard let backend = store.backend, !hunks.isEmpty else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let result = try await backend.hunk(id: id, hunks: hunks, action: action, view: view)
                if let found = result.changes { changes = found }
                said = result.said.isEmpty ? nil : result.said
                UIAccessibility.post(notification: .announcement, argument: action == "undo" ? (result.said.isEmpty ? "Undone" : result.said) : action == "keep" ? "Kept" : "Not kept")
            } catch {
                problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func comment(_ target: CommentTarget, _ text: String) async {
        guard let backend = store.backend else { return }
        let comment = PhoneComment(path: target.path, line: target.line.number, side: target.line.kind == .removed ? "o" : nil,
                                   excerpt: target.line.text.trimmed, text: text)
        do {
            _ = try await backend.comment(id: id, comments: [comment])
            said = "Sent your comment to the session."
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func openPR() {
        guard let backend = store.backend else { return }
        busy = true
        said = "Writing the pull request…"
        Task {
            defer { busy = false }
            do {
                let result = try await backend.openPullRequest(id: id)
                said = result.said
            } catch {
                said = nil
                problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// The turn's proof: risk, and a grid of what was checked.
struct ReceiptCard: View {
    var receipt: PhoneReceipt

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Receipt").font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                Spacer()
                Text(receipt.riskLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(riskInk)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(riskInk.opacity(0.16), in: .capsule)
            }
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 6) {
                ForEach(receipt.rows, id: \.self) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(row.mark == .good ? "✓" : row.mark == .bad ? "✗" : "•")
                            .foregroundStyle(row.mark == .good ? EdenTheme.checkGreen : row.mark == .bad ? EdenTheme.red : EdenTheme.needsInk)
                        Text(row.text).foregroundStyle(EdenTheme.ink).lineLimit(2)
                    }
                    .font(.system(size: 13))
                }
            }
            if !receipt.why.isEmpty && receipt.risk != "low" {
                Text("Why: \(receipt.why)").font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
            }
        }
        .padding(14)
        .edenCard(radius: 20)
        .accessibilityElement(children: .combine)
    }

    private var riskInk: Color {
        switch receipt.risk {
        case "high": EdenTheme.red
        case "medium": EdenTheme.orange
        default: Color(light: 0x1B5E2C, dark: 0x30D158)
        }
    }
}

/// One file's hunks.
struct FileCard: View {
    var file: PhoneChanges.File
    var busy: Bool
    var speaking: Bool
    var onKeep: (PhoneChanges.Hunk) -> Void
    var onUndo: (PhoneChanges.Hunk) -> Void
    var onComment: (PhoneChanges.Line) -> Void
    var onRead: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(file.path).font(.system(size: 12, design: .monospaced)).foregroundStyle(EdenTheme.ink).lineLimit(1).truncationMode(.head)
                Spacer()
                Text("+\(file.added) −\(file.removed)").font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
                Button(action: onRead) {
                    Image(systemName: speaking ? "stop.fill" : "speaker.wave.2").font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(speaking ? "Stop reading" : "Read this change aloud")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider().overlay(EdenTheme.divider)
            if file.sensitive {
                note("Credentials: changed, lines withheld.")
            } else if file.binary {
                note("A binary file changed.")
            } else if file.omitted {
                note("Too big to show here: open it on your Mac.")
            }
            ForEach(file.hunks) { hunk in
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(hunk.lines) { line in
                        Button { onComment(line) } label: { DiffLine(line: line) }
                            .buttonStyle(.plain)
                            .accessibilityHint("Comment on this line")
                    }
                    if hunk.cut > 0 { note("\(hunk.cut) more lines on your Mac.") }
                    if hunk.kept {
                        Label("Kept", systemImage: "checkmark")
                            .font(.system(size: 13)).foregroundStyle(EdenTheme.checkGreen)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .onTapGesture { onKeep(hunk) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityHint("Tap to un-keep")
                    } else {
                        HStack(spacing: 8) {
                            Button { onKeep(hunk) } label: {
                                Text("Keep").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                                    .frame(maxWidth: .infinity, minHeight: 40).background(EdenTheme.accent, in: .capsule)
                            }
                            Button { onUndo(hunk) } label: {
                                Text("Undo").font(.system(size: 15)).foregroundStyle(EdenTheme.ink)
                                    .frame(maxWidth: .infinity, minHeight: 40).background(EdenTheme.fill, in: .capsule)
                            }
                            Button { if let line = hunk.lines.first(where: { $0.kind != .context }) ?? hunk.lines.first { onComment(line) } } label: {
                                Image(systemName: "text.bubble").font(.system(size: 15)).foregroundStyle(EdenTheme.ink)
                                    .frame(width: 40, height: 40).background(EdenTheme.fill, in: .circle)
                            }
                            .accessibilityLabel("Comment on this change")
                        }
                        .buttonStyle(PressScale(scale: 0.97))
                        .disabled(busy)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Change \(hunk.n)")
                    }
                }
            }
        }
        .background(EdenTheme.card.opacity(1.1), in: .rect(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(EdenTheme.cardRim, lineWidth: 1))
        .clipShape(.rect(cornerRadius: 20))
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(EdenTheme.muted).padding(.horizontal, 14).padding(.vertical, 8)
    }
}

struct DiffLine: View {
    var line: PhoneChanges.Line

    var body: some View {
        Text("\(prefix) \(line.text)")
            .font(.system(size: 11.5, design: .monospaced))
            .lineSpacing(4)
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
            .background(background)
            .accessibilityLabel("\(line.kind == .added ? "Added" : line.kind == .removed ? "Removed" : "Line") \(line.number): \(line.text)")
    }

    private var prefix: String {
        switch line.kind {
        case .added: "+"
        case .removed: "−"
        case .context: " "
        }
    }

    private var ink: Color {
        switch line.kind {
        case .added: EdenTheme.addedInk
        case .removed: EdenTheme.removedInk
        case .context: EdenTheme.ink2
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: EdenTheme.addedBG
        case .removed: EdenTheme.removedBG
        case .context: .clear
        }
    }
}

struct CommentSheet: View {
    var target: ChangesScreen.CommentTarget
    var send: (String) -> Void
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\((target.path as NSString).lastPathComponent):\(target.line.number)").font(.system(size: 13, design: .monospaced)).foregroundStyle(EdenTheme.muted)
            DiffLine(line: target.line).clipShape(.rect(cornerRadius: 8))
            TextField("What should change here?", text: $text, axis: .vertical)
                .lineLimit(2...4)
                .focused($focused)
                .padding(12)
                .background(EdenTheme.fill, in: .rect(cornerRadius: 14))
            HStack {
                Button("Cancel") { dismiss() }.buttonStyle(.glass)
                Spacer()
                Button("Send to session") {
                    send(text.trimmed)
                    dismiss()
                }
                .buttonStyle(.glassProminent)
                .disabled(text.trimmed.isEmpty)
            }
        }
        .padding(20)
        .onAppear { focused = true }
    }
}
