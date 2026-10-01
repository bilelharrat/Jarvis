import PhotosUI
import SwiftUI

/// One Jarvis Code session: what it's doing (the transcript's tail, fetched incrementally),
/// its plan, the question it's waiting on, what it changed, and a line to send it.
struct CodeSessionView: View {
    let sessionID: Int

    @Environment(AppModel.self) private var model
    @State private var transcript = CodeTranscript()
    @State private var detail: CodeSessionDetail?
    /// Its project, branch, model and cost, from the list of sessions.
    @State private var info: CodeSession?
    @State private var failure: JarvisError?
    @State private var tab: Tab = .activity
    @State private var draft = ""
    @State private var sending = false
    @State private var confirmStop = false
    @State private var showTodos = false
    @FocusState private var composing: Bool
    @State private var attachments: [CodeAttachment] = []
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCommands = false
    @State private var commandOutput: CommandOutput?
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var confirmClose = false
    @State private var options: CodeOptions?
    @State private var rewindTo: CodeEntry?

    enum Tab: Hashable { case activity, changes, git, files }

    struct CommandOutput: Identifiable {
        let id = UUID()
        var command: String
        var output: String
        var code: Int
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $tab) {
                Text("Activity").tag(Tab.activity)
                Text("Changes").tag(Tab.changes)
                Text("Git").tag(Tab.git)
                Text("Files").tag(Tab.files)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Space.m + 4)
            .padding(.vertical, Space.xs)

            switch tab {
            case .activity: activity
            case .changes: CodeDiffView(sessionID: sessionID)
            case .git: CodeGitView(sessionID: sessionID)
            case .files: CodeFilesView(sessionID: sessionID)
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle(detail?.title ?? "Jarvis Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) { settingsMenu }
            if detail?.status.isLive == true {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        confirmStop = true
                    } label: {
                        Label("Stop", systemImage: "stop.circle.fill")
                    }
                    .tint(Palette.danger)
                    .confirmationDialog("Stop what Jarvis Code is doing?", isPresented: $confirmStop, titleVisibility: .visible) {
                        Button("Stop", role: .destructive) { Task { await stop() } }
                    } message: {
                        Text("It stops the current step. The session stays open, so you can send it something else.")
                    }
                }
            }
        }
        .sheet(isPresented: $showCommands) {
            NavigationStack {
                CodeCommandsView(sessionID: sessionID) { name in
                    showCommands = false
                    Task { await runCommand(name) }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $commandOutput) { output in
            NavigationStack { outputSheet(output) }
                .presentationDetents([.medium, .large])
        }
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: 6, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await attach(items) }
        }
        .alert("Rename Session", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Save") { act("rename", ["title": .string(newTitle)]) }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Close this session?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close Session", role: .destructive) { act("close") }
        } message: {
            Text("It stops and closes on your Mac; the transcript stays there.")
        }
        .confirmationDialog("Rewind to here?", isPresented: Binding(get: { rewindTo != nil }, set: { if !$0 { rewindTo = nil } }), titleVisibility: .visible) {
            Button("Rewind", role: .destructive) {
                if let uuid = rewindTo?.uuid { act("rewind", ["uuid": .string(uuid)], timeout: 65) }
                rewindTo = nil
            }
        } message: {
            Text("The conversation and its file changes go back to just before this message.")
        }
        .task(id: sessionID) {
            var polls = 0
            if options == nil, let api = model.pairing?.api { options = try? await api.codeOptions() }
            while !Task.isCancelled {
                if polls % 15 == 0 { await loadInfo() }
                await load()
                polls += 1
                try? await Task.sleep(for: .seconds(detail?.status.isLive ?? true ? 2 : 8))
            }
        }
    }

    // MARK: - Activity

    private var activity: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.m) {
                header
                if let todos = detail?.todos, !todos.isEmpty {
                    TodoCard(todos: todos, expanded: $showTodos)
                }
                if transcript.entries.isEmpty {
                    if let failure {
                        ErrorCallout(title: failure.title, message: failure.message)
                    } else if detail == nil {
                        ProgressView().tint(Palette.ink2).frame(maxWidth: .infinity).padding(.top, Space.xl)
                    } else {
                        Text("Nothing here yet.")
                            .font(.callout)
                            .foregroundStyle(Palette.muted)
                    }
                }
                ForEach(transcript.entries) { entry in
                    CodeEntryRow(entry: entry)
                        .contextMenu {
                            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = entry.text }
                            if entry.role == .user, entry.uuid != nil {
                                Button("Rewind to Here", systemImage: "arrow.uturn.backward") { rewindTo = entry }
                            }
                        }
                }
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.bottom, Space.m)
        }
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.bottom)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Space.s) {
                if let waiting = detail?.waiting {
                    waitingCard(waiting)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let queued = detail?.queued, !queued.isEmpty {
                    queuedStrip(queued)
                }
                if !attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: Space.xs) {
                            ForEach(attachments) { item in
                                Group {
                                    if let thumb = item.thumbnail { Thumbnail(data: thumb, side: 52) } else { DocumentChip(name: item.name) }
                                }
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        attachments.removeAll { $0.id == item.id }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 5, y: -5)
                                    .accessibilityLabel("Remove \(item.name)")
                                }
                            }
                        }
                        .padding(.top, 6)
                    }
                    .scrollIndicators(.hidden)
                }
                composer
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.top, Space.xs)
            .padding(.bottom, Space.xs)
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: detail?.waiting?.approvalID)
        }
    }

    @ViewBuilder
    private var header: some View {
        if let detail {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: Space.xs) {
                    StatusPill(text: detail.status.label, symbol: detail.status.symbol, tint: detail.status.tint)
                    if let info, !(info.project.isEmpty && info.branch.isEmpty) {
                        Text([info.project, info.branch].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.footnote.monospaced())
                            .foregroundStyle(Palette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if let info {
                    let parts = [info.model, info.costUSD.map { Money.text($0, currency: "USD") }].compactMap { $0 }.filter { !$0.isEmpty }
                    if !parts.isEmpty {
                        Text(parts.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
            .padding(.top, Space.xs)
            .accessibilityElement(children: .combine)
        }
    }

    /// The question it's waiting on, with the card's own choices when the Mac has sent
    /// them, and a "No, because…".
    @ViewBuilder
    private func waitingCard(_ waiting: CodeWaiting) -> some View {
        let approval = model.remote?.approvals.first { $0.id == waiting.approvalID }
            ?? Approval(
                id: waiting.approvalID, question: waiting.question,
                choices: [ApprovalChoice(id: "allow", label: "Yes"), ApprovalChoice(id: "deny", label: "No")],
                source: .code, taskID: sessionID
            )
        if !model.answering.contains(approval.id) {
            if approval.isQuestion {
                QuestionCard(approval: approval) { choice, feedback in
                    Task { await answer(approval, choice: choice, feedback: feedback) }
                }
            } else {
                ApprovalCard(approval: approval) { choice in
                    Task {
                        // "Always allow" sets a rule on the Mac: Face ID first.
                        if choice.id == "always", !(await OwnerCheck.confirm("Always allow this in Jarvis Code")) { return }
                        await model.answer(approval, with: choice)
                    }
                } onReason: { reason in
                    Task { await model.answer(approvalID: approval.id, choices: approval.choices, with: .denyBecause(reason)) }
                }
            }
        }
    }

    /// Messages waiting for the step to end: each can go in now, or be taken back.
    private func queuedStrip(_ queued: [CodeQueued]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Eyebrow("Waiting to send")
            ForEach(queued) { item in
                HStack(spacing: Space.xs) {
                    Text(item.text).font(.footnote).foregroundStyle(Palette.ink2).lineLimit(2)
                    Spacer(minLength: Space.xs)
                    Button("Send Now") { act("steer", ["item": .int(item.item)]) }.font(.caption)
                    Button {
                        act("unqueue", ["item": .int(item.item)])
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .accessibilityLabel("Don’t send this")
                }
            }
        }
        .padding(Space.s)
        .glassCard(cornerRadius: 16)
    }

    /// Mode, model, effort; rename, pin, archive, export, undo, context, close.
    private var settingsMenu: some View {
        Menu {
            Menu("Permissions: \(CodeOptions.modeName(detail?.mode ?? ""))", systemImage: "lock.shield") {
                ForEach(options?.modes ?? [], id: \.id) { mode in
                    Button { setMode(mode.id) } label: {
                        if detail?.mode == mode.id { Label(mode.name, systemImage: "checkmark") } else { Text(mode.name) }
                    }
                }
            }
            Menu("Model: \(detail?.modelLabel.nilIfEmpty ?? detail?.model.nilIfEmpty ?? "Default")", systemImage: "cpu") {
                ForEach(options?.models ?? [], id: \.id) { item in
                    Button(item.name) { act("model", ["ref": .string(item.id)]) }
                }
            }
            Menu("Effort: \((detail?.effort.nilIfEmpty ?? "default").capitalized)", systemImage: "gauge.with.dots.needle.67percent") {
                ForEach(options?.efforts ?? [], id: \.self) { level in
                    Button(level.capitalized) { act("effort", ["effort": .string(level)]) }
                }
            }
            Divider()
            Button("Commands", systemImage: "slash.circle") { showCommands = true }
            Button("Context Used", systemImage: "chart.pie") { showContext() }
            Button("Undo Last Change", systemImage: "arrow.uturn.backward") { act("undo", timeout: 35) }
            Divider()
            Button("Rename", systemImage: "pencil") {
                newTitle = detail?.title ?? ""
                renaming = true
            }
            Button("Pin", systemImage: "pin") { act("meta", ["pinned": .bool(true)]) }
            Button("Archive", systemImage: "archivebox") { act("meta", ["archived": .bool(true)]) }
            Button("Export Transcript", systemImage: "square.and.arrow.up") { act("export") }
            Button("Close Session", systemImage: "xmark.circle", role: .destructive) { confirmClose = true }
        } label: {
            Label("Session", systemImage: "ellipsis.circle")
        }
    }

    private func outputSheet(_ output: CommandOutput) -> some View {
        ScrollView([.vertical, .horizontal]) {
            Text(output.output.isEmpty ? "(no output)" : output.output)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("$ \(output.command)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { commandOutput = nil } }
            ToolbarItem(placement: .status) {
                Text(output.code == 0 ? "Exit 0" : "Exit \(output.code)").font(.caption).foregroundStyle(output.code == 0 ? Palette.online : Palette.danger)
            }
        }
    }

    private var composer: some View {
        HStack(spacing: Space.xs) {
            Menu {
                Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                Button("Commands", systemImage: "slash.circle") { showCommands = true }
                Button("Run a Command (!)", systemImage: "terminal") { draft = draft.hasPrefix("!") ? draft : "!" + draft }
            } label: {
                Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(Palette.ink2).frame(width: 36, height: 44)
            }
            .padding(.leading, 6)
            .accessibilityLabel("Attach, commands")
            TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.muted), axis: .vertical)
                .lineLimit(1...4)
                .focused($composing)
                .submitLabel(.send)
                .onSubmit { Task { await send() } }
                .foregroundStyle(Palette.ink)
                .padding(.vertical, Space.s)
                .accessibilityLabel("Message Jarvis Code")
            Button {
                Task { await send() }
            } label: {
                Group {
                    if sending {
                        ProgressView().tint(Palette.onAction)
                    } else {
                        Image(systemName: "arrow.up").font(.body.weight(.bold))
                    }
                }
                .foregroundStyle(canSend ? Palette.onAction : Palette.muted)
                .frame(width: 36, height: 36)
                .background(Circle().fill(canSend ? AnyShapeStyle(Palette.action) : AnyShapeStyle(Color.white.opacity(0.07))))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
            }
            .buttonStyle(PressableStyle())
            .disabled(!canSend)
            .padding(.trailing, 4)
            .accessibilityLabel("Send to Jarvis Code")
        }
        .frame(minHeight: 52)
        .glass(RoundedRectangle(cornerRadius: 26, style: .continuous), tint: composing ? Palette.cyan : .white, strength: composing ? 0.6 : 1)
    }

    private var canSend: Bool { (!draft.trimmed.isEmpty || !attachments.isEmpty) && !sending }

    private var placeholder: String {
        if draft.hasPrefix("!") { return "A command to run in the project" }
        return detail?.status == .working ? "Message (waits for this step)…" : "Message Jarvis Code…"
    }

    // MARK: - Talking to the Mac

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            var fetched = try await api.codeSession(id: sessionID, after: transcript.after)
            transcript.merge(fetched.entries)
            // A full page means more may be right behind it.
            var rounds = 0
            while fetched.entries.count >= CodeSessionDetail.page, rounds < 4, !Task.isCancelled {
                fetched = try await api.codeSession(id: sessionID, after: transcript.after)
                transcript.merge(fetched.entries)
                rounds += 1
            }
            if detail != fetched { detail = fetched }
            failure = nil
        } catch is CancellationError {
        } catch {
            failure = model.handle(error)
        }
    }

    private func loadInfo() async {
        guard let api = model.pairing?.api else { return }
        if let found = try? await api.codeSessions().first(where: { $0.id == sessionID }) {
            info = found
        }
    }

    private func send() async {
        let text = draft.trimmed
        guard canSend, let api = model.pairing?.api else { return }
        if text.hasPrefix("!") {
            return await bash(String(text.dropFirst()).trimmed)
        }
        if text.hasPrefix("/"), attachments.isEmpty {
            draft = ""
            return await runCommand(text)
        }
        sending = true
        defer { sending = false }
        do {
            if attachments.isEmpty {
                _ = try await api.codeSend(id: sessionID, text: text)
            } else {
                _ = try await api.codeSend(id: sessionID, text: text, attachments: attachments, steer: nil)
                attachments = []
            }
            draft = ""
            composing = false
            Haptics.tap()
            await load()
        } catch let error as JarvisError where error.neverDelivered {
            draft = ""
            model.keep(.codeSend(session: sessionID, text: text, title: detail?.title ?? "Jarvis Code"))
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }

    /// A "!" command in the project, on the Mac, after Face ID; its output here.
    private func bash(_ command: String) async {
        guard !command.isEmpty, let api = model.pairing?.api else { return }
        guard await OwnerCheck.confirm("Run “\(command)” on your Mac") else { return }
        sending = true
        defer { sending = false }
        do {
            let result = try await api.codeAction("bash", session: sessionID, ["command": .string(command)], timeout: 135)
            draft = ""
            let found = result["task_bash"]
            commandOutput = CommandOutput(command: command, output: found?["output"]?.stringValue ?? result.said,
                                          code: found?["code"]?.intValue ?? -1)
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    /// A slash command (/plan, /review, the project's own…).
    private func runCommand(_ text: String) async {
        guard let api = model.pairing?.api else { return }
        do {
            let result = try await api.codeAction("command", session: sessionID, ["text": .string(text)], timeout: 20)
            Haptics.tap()
            if !result.said.isEmpty { model.show(result.said) }
            await load()
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    private func setMode(_ mode: String) {
        Task {
            if CodeOptions.needsOwner(mode: mode), !(await OwnerCheck.confirm("Let this session run everything without asking")) { return }
            act("mode", ["mode": .string(mode)])
        }
    }

    private func showContext() {
        Task {
            guard let api = model.pairing?.api else { return }
            if let result = try? await api.codeAction("context", session: sessionID, timeout: 20),
               let percent = result["task_context"]?["percent"]?.intValue {
                model.show("\(percent)% of the context is used.")
            } else {
                model.show("The session isn’t running, so there’s no context to measure.")
            }
        }
    }

    /// One of the Mac's session actions, then a fresh look.
    private func act(_ action: String, _ fields: [String: JSONValue] = [:], timeout: TimeInterval = 30) {
        Task {
            guard let api = model.pairing?.api else { return }
            do {
                let result = try await api.codeAction(action, session: sessionID, fields, timeout: timeout)
                (result.ok ? Haptics.tap() : Haptics.failure())
                if !result.said.isEmpty { model.show(result.said, style: result.ok ? .info : .problem) }
                await load()
            } catch {
                if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            }
        }
    }

    /// A question's answer: an option, several ("pick"), or the owner's own words ("other").
    private func answer(_ approval: Approval, choice: String, feedback: String) async {
        guard let api = model.pairing?.api else { return }
        do {
            _ = try await api.approve(id: approval.id, choice: choice, feedback: feedback.isEmpty ? nil : feedback)
            Haptics.answered(negative: false)
            await load()
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    private func attach(_ items: [PhotosPickerItem]) async {
        for image in await Attachment.load(items) {
            guard attachments.count < 6,
                  let jpeg = PhotoPrep.jpeg(from: image, longest: 1568, maxBytes: 4 * 1024 * 1024) else { continue }
            let thumb = Attachment(image: image)?.thumbnail
            attachments.append(CodeAttachment(name: "screenshot-\(attachments.count + 1).jpg", mediaType: "image/jpeg", data: jpeg, thumbnail: thumb))
        }
    }

    private func stop() async {
        guard let api = model.pairing?.api else { return }
        do {
            _ = try await api.codeStop(id: sessionID)
            Haptics.answered(negative: true)
            model.show("Stopped the current step.", style: .success)
            await load()
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }
}

/// The session's plan: how far along, and each step when opened.
private struct TodoCard: View {
    let todos: [CodeTodo]
    @Binding var expanded: Bool

    var body: some View {
        let done = todos.filter(\.done).count
        VStack(alignment: .leading, spacing: Space.s) {
            Button {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) { expanded.toggle() }
            } label: {
                HStack(spacing: Space.xs) {
                    Eyebrow("Plan")
                    Text("\(done) of \(todos.count) done")
                        .font(.footnote.weight(.medium).monospacedDigit())
                        .foregroundStyle(Palette.ink2)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.muted)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            ProgressView(value: Double(done), total: Double(max(todos.count, 1)))
                .tint(Palette.cyan)
            if expanded {
                VStack(alignment: .leading, spacing: Space.xs) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                        Label {
                            Text(todo.text)
                                .font(.subheadline)
                                .foregroundStyle(todo.done ? Palette.muted : Palette.ink)
                                .strikethrough(todo.done, color: Palette.muted)
                        } icon: {
                            Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(todo.done ? Palette.online : Palette.muted)
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(Space.m)
        .glassCard(cornerRadius: 18)
        .accessibilityElement(children: .combine)
    }
}

/// One entry of a session's transcript.
private struct CodeEntryRow: View {
    let entry: CodeEntry

    var body: some View {
        switch entry.role {
        case .user:
            VStack(alignment: .leading, spacing: 5) {
                label("You", color: Palette.muted)
                Text(entry.text)
                    .font(.callout)
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
        case .assistant:
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    OrbMark(size: 9)
                    label("Jarvis Code", color: Palette.ice.opacity(0.9))
                }
                Text(TranscriptRow.markdown(entry.text))
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(3)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
        case .tool:
            HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.caption2)
                    .foregroundStyle(Palette.muted)
                Text(entry.text)
                    .font(.caption.monospaced())
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(4)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, Space.s)
            .padding(.vertical, Space.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.well.opacity(0.5)))
            .accessibilityLabel("Tool: \(entry.text)")
        case .note:
            Text(entry.text)
                .font(.footnote.italic())
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func label(_ text: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Eyebrow(text, color: color)
            if let at = entry.at {
                Text(at.formatted(date: .omitted, time: .shortened))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Palette.muted.opacity(0.75))
            }
        }
    }
}
