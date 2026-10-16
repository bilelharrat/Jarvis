import PhotosUI
import SwiftUI

/// One session, live (PhoneSession mockup): a floating glass header pill (back, title,
/// project · model, Changes), the transcript (the owner's words in blue bubbles, steps as
/// "✓ Read file" lines, Eden's replies on glass with Read aloud and the files changed), its
/// cards inline, the isolated copy's Land and Discard, and Eden chat's composer.
struct SessionScreen: View {
    let id: Int
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: SessionModel?
    @State private var text = ""
    @State private var dictation = Dictation()
    @State private var pictures: [CodeAttachment] = []
    @State private var confirmCopy: String?
    private let speaker = Speaker.shared

    var body: some View {
        ZStack(alignment: .top) {
            EdenBackground()
            if let model {
                transcript(model)
            }
            header
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
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

    // MARK: - The header pill

    private var header: some View {
        HStack(spacing: 10) {
            RoundGlassButton(symbol: "chevron.left", label: "Back to sessions") { dismiss() }
            VStack(spacing: 1) {
                Text(model?.title ?? "Session").font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink).lineLimit(1)
                Text(subtitle).font(.system(size: 11)).foregroundStyle(EdenTheme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            RoundGlassButton(symbol: "plus.forwardslash.minus", label: "Changes") { store.path.append(.changes(id)) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    private var subtitle: String {
        guard let view = model?.view else { return "" }
        return [view.project, view.modelLabel].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: - The transcript

    private func transcript(_ model: SessionModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    Color.clear.frame(height: 56)
                    if let problem = model.problem { ProblemBanner(text: problem) }
                    ForEach(model.rows) { row in
                        rowView(row, model: model).id(row.id)
                    }
                    if !model.view.live.isEmpty {
                        ReplyBubble(text: model.view.live, typing: true, speaking: false, filesChanged: 0, onRead: {}, onChanges: {})
                            .id("live")
                    }
                    ForEach(model.view.cards) { card in
                        InlineCard(card: card)
                    }
                    if let copy = model.view.copy { copyBar(copy) }
                    if !model.view.todos.isEmpty { todoList(model.view.todos) }
                    Text(model.statusLine)
                        .font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
                        .frame(maxWidth: .infinity)
                        .accessibilityAddTraits(.updatesFrequently)
                        .id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.entries.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.view.live) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private func rowView(_ row: SessionModel.Row, model: SessionModel) -> some View {
        switch row {
        case .user(let entry):
            Text(entry.text)
                .font(.system(size: 15))
                .lineSpacing(3)
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(EdenTheme.accent, in: .rect(cornerRadius: 20))
                .frame(maxWidth: 300, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)
                .accessibilityLabel("You: \(entry.text)")
        case .steps(let steps):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    let running = index == steps.count - 1 && model.working && step.stepRunning
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if running {
                            ProgressView().controlSize(.mini).tint(EdenTheme.accent).frame(width: 12)
                        } else {
                            Text(step.stepFailed ? "✗" : "✓")
                                .foregroundStyle(step.stepFailed ? EdenTheme.red : EdenTheme.checkGreen)
                        }
                        Text(step.stepLine.replacingOccurrences(of: "…", with: ""))
                            .foregroundStyle(running ? EdenTheme.ink : EdenTheme.ink2)
                            .lineLimit(2)
                    }
                    .font(.system(size: 14))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel((running ? "Running: " : "Done: ") + step.stepLine)
                }
            }
            .padding(.horizontal, 2)
        case .reply(let entry):
            ReplyBubble(text: entry.text, typing: false, speaking: speaker.speaking == "r\(entry.i)",
                        filesChanged: entry.i == lastReply ? filesChanged : 0,
                        onRead: { speaker.toggle(entry.text, id: "r\(entry.i)") },
                        onChanges: { store.path.append(.changes(id)) })
        case .note(let entry):
            Text(entry.text)
                .font(.system(size: 13))
                .foregroundStyle(EdenTheme.muted)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(EdenTheme.fill.opacity(0.6), in: .rect(cornerRadius: 14))
        }
    }

    private var lastReply: Int? {
        model?.entries.last(where: { $0.role == .assistant })?.i
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
        .edenCard()
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
        .edenCard()
    }

    // MARK: - The composer

    private var composer: some View {
        let view = model?.view
        return VStack(spacing: 6) {
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
                .glassEffect(.regular, in: .capsule)
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
        }
        .padding(.bottom, 8)
    }

    private func submit(steer: Bool) {
        let message = text
        let attached = pictures
        dictation.stop()
        text = ""
        pictures = []
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

/// Eden's reply on glass, with Read aloud and the files it changed.
struct ReplyBubble: View {
    var text: String
    var typing: Bool
    var speaking: Bool
    var filesChanged: Int
    var onRead: () -> Void
    var onChanges: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(text))
                .font(.system(size: 15))
                .lineSpacing(3)
                .foregroundStyle(EdenTheme.ink)
                .textSelection(.enabled)
            if typing {
                HStack(spacing: 4) {
                    ForEach(0..<3) { _ in Circle().fill(EdenTheme.muted).frame(width: 5, height: 5) }
                }
                .accessibilityLabel("Writing")
            } else {
                HStack(spacing: 8) {
                    Button(action: onRead) {
                        Chip(text: speaking ? "Stop" : "Read aloud", symbol: speaking ? "stop.fill" : "play.fill")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(speaking ? "Stop reading" : "Read aloud")
                    if filesChanged > 0 {
                        Button(action: onChanges) { Chip(text: "\(filesChanged) file\(filesChanged == 1 ? "" : "s") changed") }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: 360, alignment: .leading)
        .background(EdenTheme.card, in: .rect(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(EdenTheme.cardRim, lineWidth: 1))
    }
}

/// A card inside the transcript: opens the approval sheet.
struct InlineCard: View {
    var card: PhoneCard
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        Button { store.sheetCard = card } label: {
            HStack(spacing: 12) {
                Image(systemName: card.approval.isQuestion ? "questionmark.bubble.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(.white).frame(width: 34, height: 34)
                    .background(card.approval.isQuestion ? EdenTheme.accent : EdenTheme.orange, in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 1) {
                    Text(card.approval.question).font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink).lineLimit(2)
                    Text(card.macOnly ? "Answer on your Mac" : "Tap to answer").font(.system(size: 13)).foregroundStyle(EdenTheme.needsInk)
                }
                Spacer()
            }
            .padding(12)
            .background(EdenTheme.orange.opacity(0.14), in: .rect(cornerRadius: 18))
        }
        .buttonStyle(.plain)
    }
}
