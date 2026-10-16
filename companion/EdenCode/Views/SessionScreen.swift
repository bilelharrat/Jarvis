import PhotosUI
import SwiftUI

/// One session, filling the screen (G1, GChat.dc.html): the soft wallpaper; three floating
/// glass controls (☰ opens the drawer; the title pill with the session's name and one
/// coloured word, "Working · askeden"; ✎ starts a new session); the owner's words in blue,
/// Eden's replies in frosted bubbles, steps in one glass panel of ✓ lines, "N files changed ›"
/// (the Changes screen), one live status line; Eden chat's input bar at the bottom. A card
/// that waits on the owner takes the input bar's place (G4, GAsk.dc.html) until answered, or
/// until "Reply instead".
struct SessionScreen: View {
    let id: Int
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.drawerProgress) private var drawer
    @State private var model: SessionModel?
    @State private var text = ""
    @State private var dictation = Dictation()
    @State private var pictures: [CodeAttachment] = []
    @State private var confirmCopy: String?
    /// Cards answered here, hidden before the Mac's next answer drops them.
    @State private var answered: Set<String> = []
    /// "Reply instead": the card whose question the input bar answers in words.
    @State private var replyingTo: String?
    private let speaker = Speaker.shared

    var body: some View {
        GeometryReader { geo in
            let top = geo.safeAreaInsets.top
            ZStack(alignment: .top) {
                EdenBackground()
                Group {
                    if let model {
                        transcript(model, top: top, width: geo.size.width)
                    }
                    header
                        .padding(.top, top + 5)
                        .ignoresSafeArea(edges: .top)
                }
                .movesForDrawer(drawer)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottom.movesForDrawer(drawer)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            if model == nil, let backend = store.backend {
                model = SessionModel(id: id, backend: backend)
                #if DEBUG
                if let typed = EdenDebug.typed { text = typed }
                #endif
            }
            model?.start()
        }
        .onDisappear {
            model?.stopWatching()
            dictation.stop()
        }
        .onChange(of: dictation.heard) { _, heard in
            if !heard.isEmpty { text = heard }
        }
        .onChange(of: model?.entries.last?.i) { _, _ in
            guard store.speakReplies, let last = model?.entries.last, last.role == .assistant else { return }
            speaker.speak(last.text, id: "r\(last.i)")
        }
        .confirmationDialog(confirmCopy == "land" ? "Land this copy into its branch?" : "Discard this copy?",
                            isPresented: Binding(get: { confirmCopy != nil }, set: { if !$0 { confirmCopy = nil } }),
                            titleVisibility: .visible) {
            Button(confirmCopy == "land" ? "Land" : "Discard", role: confirmCopy == "land" ? nil : .destructive) {
                let action = confirmCopy
                Task { if action == "land" { await model?.land() } else { await model?.discard() } }
            }
        } message: {
            Text("Your Mac puts up its card; answer it here or there.")
        }
    }

    // MARK: - The three glass controls

    private var header: some View {
        HStack(spacing: 10) {
            GCircleButton(glyph: MenuGlyph(), label: "Your sessions") { store.drawerOpen = true }
            titlePill
            GCircleButton(glyph: PencilGlyph(), label: "New session") { store.startNew() }
        }
        .padding(.horizontal, 16)
    }

    /// The summary from the session list until the session's own view comes.
    private var summary: PhoneSummary? { store.home.sessions.first { $0.id == id } }

    private var status: CodeStatus {
        if pendingCard != nil { return .needsYou }
        if let model, model.view.status != .unknown { return model.view.status }
        return summary?.status ?? .unknown
    }

    private var title: String { model.map(\.title) ?? summary?.title ?? "Session" }
    private var project: String {
        let project = model?.view.project ?? ""
        return project.isEmpty ? summary?.project ?? "" : project
    }

    private var titlePill: some View {
        Menu {
            if filesChanged > 0 || model?.latestReceipt != nil {
                Button { store.path.append(.changes(id)) } label: { Label("See the changes", systemImage: "plus.forwardslash.minus") }
            }
            if let last = model?.entries.last(where: { $0.role == .assistant }) {
                Button { speaker.toggle(last.text, id: "last") } label: {
                    Label(speaker.speaking == "last" ? "Stop reading" : "Read the last reply aloud", systemImage: "speaker.wave.2")
                }
            }
            if model?.working ?? false {
                Button(role: .destructive) { Task { await model?.stop() } } label: { Label("Stop", systemImage: "stop.fill") }
            }
            Button { store.drawerOpen = true } label: { Label("Your sessions", systemImage: "list.bullet") }
        } label: {
            VStack(spacing: 0) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(EdenTheme.ink)
                    .lineLimit(1)
                    .frame(maxWidth: 200)
                HStack(spacing: 5) {
                    Circle().fill(EdenTheme.dot(status)).frame(width: 6, height: 6)
                    Text([GStatus.word(status), project].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.system(size: 11))
                        .lineLimit(1)
                }
                .foregroundStyle(GStatus.ink(status))
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44, maxHeight: 44)
            .contentShape(.capsule)
        }
        .gGlass(Capsule(), interactive: true)
        .accessibilityLabel("\(title). \(GStatus.word(status))\(project.isEmpty ? "" : ", \(project)")")
        .accessibilityHint("Session actions")
    }

    // MARK: - The transcript

    private func transcript(_ model: SessionModel, top: CGFloat, width: CGFloat) -> some View {
        let inner = width - 40
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: pendingCard == nil ? 18 : 16) {
                    if let problem = model.problem ?? store.problem { ProblemBanner(text: problem) }
                    ForEach(rows(model)) { row in
                        rowView(row, model: model, inner: inner).id(row.id)
                    }
                    if !model.view.live.isEmpty {
                        ReplyBubble(text: model.view.live, typing: true)
                            .frame(maxWidth: inner * 0.88 + 28, alignment: .leading)
                            .id("live")
                    }
                    if filesChanged > 0 {
                        Button { store.path.append(.changes(id)) } label: {
                            HStack(spacing: 8) {
                                DiffGlyph().stroke(EdenTheme.ink, lineWidth: 1.6).frame(width: 16, height: 16)
                                Text("\(filesChanged) file\(filesChanged == 1 ? "" : "s") changed").font(.system(size: 14)).foregroundStyle(EdenTheme.ink)
                                Text("›").font(.system(size: 14)).foregroundStyle(EdenTheme.chevron)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .contentShape(.rect)
                        }
                        .buttonStyle(PressScale(scale: 0.97))
                        .gGlass(RoundedRectangle(cornerRadius: 14, style: .continuous), interactive: true)
                        .accessibilityLabel("\(filesChanged) files changed. See the changes")
                    }
                    if let copy = model.view.copy { copyBar(copy) }
                    if !model.view.todos.isEmpty { todoList(model.view.todos) }
                    if model.working {
                        HStack(spacing: 10) {
                            Spinner(size: 14)
                            Text(model.view.doing.isEmpty ? "Working" : model.view.doing.replacingOccurrences(of: "…", with: ""))
                                .font(.system(size: 14))
                                .foregroundStyle(EdenTheme.muted)
                                .lineLimit(1)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(model.statusLine)
                        .accessibilityAddTraits(.updatesFrequently)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 20)
                .padding(.top, top + 61)
                .padding(.bottom, 24)
            }
            .ignoresSafeArea(edges: .top)
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.entries.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.view.live) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    /// The rows, less the step that is running now (the live status line says it).
    private func rows(_ model: SessionModel) -> [SessionModel.Row] {
        SessionModel.visibleRows(model.rows, working: model.working)
    }

    @ViewBuilder
    private func rowView(_ row: SessionModel.Row, model: SessionModel, inner: CGFloat) -> some View {
        switch row {
        case .user(let entry):
            UserBubble(text: entry.text)
                .frame(maxWidth: inner * 0.78 + 28, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .steps(let steps):
            StepsPanel(steps: steps)
        case .reply(let entry):
            ReplyBubble(text: entry.text, typing: false)
                .frame(maxWidth: inner * 0.88 + 28, alignment: .leading)
                .contextMenu {
                    Button { UIPasteboard.general.string = entry.text } label: { Label("Copy", systemImage: "doc.on.doc") }
                    Button { speaker.toggle(entry.text, id: "r\(entry.i)") } label: {
                        Label(speaker.speaking == "r\(entry.i)" ? "Stop reading" : "Read aloud", systemImage: "speaker.wave.2")
                    }
                    if filesChanged > 0 {
                        Button { store.path.append(.changes(id)) } label: { Label("See the changes", systemImage: "plus.forwardslash.minus") }
                    }
                }
        case .note(let entry):
            Text(entry.text)
                .font(.system(size: 13))
                .foregroundStyle(EdenTheme.muted)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(EdenTheme.fill.opacity(0.6), in: .rect(cornerRadius: 14))
        }
    }

    private var filesChanged: Int {
        model?.latestReceipt?.fileCount ?? 0
    }

    private func copyBar(_ copy: PhoneView.Copy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").foregroundStyle(EdenTheme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Isolated copy").font(.system(size: 14, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                Text("\(copy.branch) → \(copy.into)").font(.system(size: 12)).foregroundStyle(EdenTheme.muted).lineLimit(1)
            }
            Spacer()
            Button("Discard") { confirmCopy = "discard" }.buttonStyle(.glass).disabled(copy.busy)
            Button("Land") { confirmCopy = "land" }.buttonStyle(.glassProminent).disabled(copy.busy)
        }
        .font(.system(size: 13, weight: .semibold))
        .padding(12)
        .gGlass(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func todoList(_ todos: [PhoneView.Todo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Plan").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.muted)
            ForEach(todos, id: \.self) { todo in
                Label(todo.text, systemImage: todo.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(todo.done ? EdenTheme.muted : EdenTheme.ink)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .gGlass(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    // MARK: - The bottom: a card that waits, or the input bar

    /// The first card of this session's that waits on the owner.
    private var pendingCard: PhoneCard? {
        let cards = (model?.view.cards ?? []) + store.home.attention.filter { $0.taskID == id }
        return cards.first { !answered.contains($0.id) }
    }

    @ViewBuilder private var bottom: some View {
        if let card = pendingCard, replyingTo != card.id {
            AskCard(card: card,
                    onReply: card.macOnly ? nil : { replyingTo = card.id },
                    onAnswered: { answered.insert(card.id) })
                .id(card.id)
                .padding(.horizontal, 12)
                .padding(.bottom, -4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
            composer
        }
    }

    private var replyCard: PhoneCard? {
        guard let replyingTo, let card = pendingCard, card.id == replyingTo else { return nil }
        return card
    }

    private var composer: some View {
        let view = model?.view
        return VStack(spacing: 6) {
            if let card = replyCard {
                Button { replyingTo = nil } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrowshape.turn.up.left.fill").font(.system(size: 11))
                        Text("Replying to: \(card.approval.question)").lineLimit(1)
                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                    }
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(EdenTheme.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .gGlass(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Replying to \(card.approval.question). Back to the question")
            }
            if let said = model?.said {
                Text(said).font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
            }
            if let problem = dictation.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(EdenTheme.failInk)
            }
            if !pictures.isEmpty {
                HStack {
                    Label("\(pictures.count) picture\(pictures.count == 1 ? "" : "s")", systemImage: "photo")
                    Button { pictures = [] } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove pictures")
                }
                .font(.system(size: 12, weight: .medium)).foregroundStyle(EdenTheme.ink2)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .gGlass(Capsule())
            }
            EdenComposer(
                text: $text,
                working: model?.working ?? false,
                modeID: view?.mode ?? "ask",
                modeLabel: view?.modeLabel ?? "Manual",
                modelLabel: view?.modelLabel ?? "",
                modes: store.options.modes,
                models: store.options.models,
                dictating: dictation.listening,
                talking: speaker.speaking == "last",
                attachments: pictures.count,
                onSend: { submit(steer: false) },
                onSteer: { submit(steer: true) },
                onStop: { Task { await model?.stop() } },
                onDictate: { Task { await dictation.toggle() } },
                onTalk: {
                    if let last = model?.entries.last(where: { $0.role == .assistant }) { speaker.toggle(last.text, id: "last") }
                },
                onMode: { mode in Task { await model?.setMode(mode) } },
                onModel: { chosen in Task { await model?.setModel(chosen) } },
                onPictures: { items in Task { pictures += await Self.load(items) } }
            )
            .padding(.horizontal, 4)
        }
        .padding(.bottom, -4)
    }

    private func submit(steer: Bool) {
        let message = text
        let attached = pictures
        dictation.stop()
        text = ""
        pictures = []
        if let card = replyCard {
            // "Reply instead": the card's no, with the owner's words for what to do instead.
            Task {
                if await store.answer(card, card.noChoice, feedback: message.trimmed) {
                    answered.insert(card.id)
                    replyingTo = nil
                } else {
                    text = message
                }
            }
            return
        }
        Task {
            let sent = await model?.send(message, steer: steer, pictures: attached) ?? false
            if !sent { text = message; pictures = attached }
        }
    }

    /// Pictures from the photo picker as JPEGs the Mac's composer takes (at most 8 MB each).
    static func load(_ items: [PhotosPickerItem]) async -> [CodeAttachment] {
        var out: [CodeAttachment] = []
        for (index, item) in items.prefix(6).enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            let scaled = image.preparingThumbnail(of: fitting(image.size, 2048)) ?? image
            guard let jpeg = scaled.jpegData(compressionQuality: 0.8), jpeg.count < 8_000_000 else { continue }
            out.append(CodeAttachment(name: "photo-\(index + 1).jpg", mediaType: "image/jpeg", data: jpeg, thumbnail: nil))
        }
        return out
    }

    private static func fitting(_ size: CGSize, _ most: CGFloat) -> CGSize {
        let scale = min(1, most / max(size.width, size.height))
        return CGSize(width: size.width * scale, height: size.height * scale)
    }
}

/// The owner's words: the mockup's blue bubble (88 % blue with a light sheen from the top,
/// 20 pt corners, a blue glow under it).
struct UserBubble: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.system(size: 16))
            .lineSpacing(2.5)
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(EdenTheme.accent.opacity(0.88))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(LinearGradient(stops: [.init(color: .white.opacity(0.25), location: 0), .init(color: .white.opacity(0), location: 0.55)],
                                                 startPoint: .top, endPoint: .bottom))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(0.45), location: 0), .init(color: .clear, location: 0.12)],
                                                         startPoint: .top, endPoint: .bottom), lineWidth: 1)
                    }
                    .shadow(color: EdenTheme.accent.opacity(0.25), radius: 8, y: 6)
            }
            .textSelection(.enabled)
            .accessibilityLabel("You: \(text)")
    }
}

/// Eden's reply in a frosted glass bubble (Copy and Read aloud on a long press).
struct ReplyBubble: View {
    var text: String
    var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(text))
                .font(.system(size: 16))
                .lineSpacing(5)
                .foregroundStyle(EdenTheme.ink)
            if typing {
                HStack(spacing: 4) {
                    ForEach(0..<3) { _ in Circle().fill(EdenTheme.muted).frame(width: 5, height: 5) }
                }
                .accessibilityLabel("Writing")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .gGlass(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// The steps in one glass panel of ✓ lines (✗ for one that failed).
struct StepsPanel: View {
    var steps: [PhoneEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps) { step in
                (Text(step.stepFailed ? "✗" : "✓").foregroundStyle(step.stepFailed ? EdenTheme.red : EdenTheme.green)
                 + Text(" " + step.stepLine.replacingOccurrences(of: "…", with: "")).foregroundStyle(EdenTheme.ink2))
                    .font(.system(size: 14))
                    .lineLimit(2)
                    .accessibilityLabel((step.stepFailed ? "Failed: " : "Done: ") + step.stepLine)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .gGlass(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
