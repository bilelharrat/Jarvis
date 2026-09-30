import SwiftUI

/// What a Jarvis Code session changed: each file with its counts, and its hunks when opened.
/// Files that may hold secrets come without their lines.
struct CodeDiffView: View {
    let sessionID: Int

    @Environment(AppModel.self) private var model
    @State private var state: Loadable<CodeDiff> = .loading
    @State private var open: Set<String> = []

    var body: some View {
        Group {
            if let diff = state.value {
                if diff.files.isEmpty {
                    ContentUnavailableView {
                        Label("No changes", systemImage: "doc.text.magnifyingglass")
                    } description: {
                        Text("This session hasn’t changed any files yet.")
                    }
                } else {
                    content(diff)
                }
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .task(id: sessionID) { await load(openFirst: true) }
        .refreshable { await load() }
    }

    private func content(_ diff: CodeDiff) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.xs) {
                    Text(diff.files.count == 1 ? "1 file" : "\(diff.files.count) files")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                    counts(added: diff.added, removed: diff.removed)
                    Spacer(minLength: 0)
                }
                .padding(.top, Space.xs)
                ForEach(diff.files) { file in
                    fileCard(file)
                }
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.bottom, Space.l)
        }
    }

    private func fileCard(_ file: DiffFile) -> some View {
        let isOpen = open.contains(file.path)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) {
                    if isOpen { open.remove(file.path) } else { open.insert(file.path) }
                }
            } label: {
                HStack(spacing: Space.xs) {
                    Text(file.status.rawValue)
                        .font(.caption.weight(.bold).monospaced())
                        .foregroundStyle(tint(for: file.status))
                        .frame(width: 20, height: 20)
                        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(tint(for: file.status).opacity(0.14)))
                    Text(file.path)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: Space.xxs)
                    counts(added: file.added, removed: file.removed)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.muted)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(Space.s)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.status.label): \(file.path), \(file.added) added, \(file.removed) removed")
            .accessibilityHint(isOpen ? "Hides the changes" : "Shows the changes")

            if isOpen {
                Rectangle().fill(Palette.hairline).frame(height: 0.5)
                if file.isHidden {
                    Label("Not shown: this file may hold secrets.", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                        .padding(Space.s)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                            HunkView(hunk: hunk)
                        }
                    }
                }
            }
        }
        .glassCard(cornerRadius: 14)
    }

    private func counts(added: Int, removed: Int) -> some View {
        HStack(spacing: 4) {
            Text("+\(added)").foregroundStyle(Palette.online)
            Text("−\(removed)").foregroundStyle(Palette.danger)
        }
        .font(.caption.weight(.semibold).monospacedDigit())
    }

    private func tint(for status: DiffFile.Status) -> Color {
        switch status {
        case .added: Palette.online
        case .deleted: Palette.danger
        case .modified: Palette.amber
        }
    }

    private func load(openFirst: Bool = false) async {
        guard let api = model.pairing?.api else { return }
        do {
            let diff = try await api.codeDiff(id: sessionID)
            state = .loaded(diff)
            if openFirst, open.isEmpty, let first = diff.files.first(where: { !$0.isHidden }) {
                open.insert(first.path)
            }
        } catch is CancellationError {
        } catch {
            guard model.handle(error) != nil else { return }
            if state.value == nil { state = .from(error) }
        }
    }
}

/// One hunk: its header, then its lines, colored by kind; long lines scroll sideways.
private struct HunkView: View {
    let hunk: DiffHunk
    @State private var visibleWidth: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(hunk.header)
                .font(.caption2.monospaced())
                .foregroundStyle(Palette.cyan.opacity(0.8))
                .lineLimit(1)
                .padding(.horizontal, Space.s)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.cyan.opacity(0.06))
            ScrollView(.horizontal) {
                // A grid's one column is as wide as its widest line (and at least the card),
                // so every line's color runs the full width.
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow { Color.clear.frame(width: visibleWidth, height: 0) }
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        let kind = DiffLineKind(line)
                        GridRow {
                            Text(line.isEmpty ? " " : line)
                                .font(.caption.monospaced())
                                .foregroundStyle(kind == .context ? Palette.ink2 : Palette.ink)
                                .fixedSize()
                                .padding(.horizontal, Space.s)
                                .padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(background(kind))
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { visibleWidth = $0 }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(hunk.lines.filter { DiffLineKind($0) == .added }.count) lines added, \(hunk.lines.filter { DiffLineKind($0) == .removed }.count) removed")
    }

    private func background(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .added: Palette.online.opacity(0.12)
        case .removed: Palette.danger.opacity(0.12)
        case .context: .clear
        }
    }
}
