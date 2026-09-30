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

    enum Tab: Hashable { case activity, changes }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $tab) {
                Text("Activity").tag(Tab.activity)
                Text("Changes").tag(Tab.changes)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Space.m + 4)
            .padding(.vertical, Space.xs)

            switch tab {
            case .activity: activity
            case .changes: CodeDiffView(sessionID: sessionID)
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle(detail?.title ?? "Jarvis Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
        .task(id: sessionID) {
            var polls = 0
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
            ApprovalCard(approval: approval) { choice in
                Task { await model.answer(approval, with: choice) }
            } onReason: { reason in
                Task { await model.answer(approvalID: approval.id, choices: approval.choices, with: .denyBecause(reason)) }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: Space.xs) {
            TextField("", text: $draft, prompt: Text("Message Jarvis Code…").foregroundStyle(Palette.muted), axis: .vertical)
                .lineLimit(1...4)
                .focused($composing)
                .submitLabel(.send)
                .onSubmit { Task { await send() } }
                .foregroundStyle(Palette.ink)
                .padding(.leading, Space.m + 4)
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

    private var canSend: Bool { !draft.trimmed.isEmpty && !sending }

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
        guard !text.isEmpty, !sending, let api = model.pairing?.api else { return }
        sending = true
        defer { sending = false }
        do {
            _ = try await api.codeSend(id: sessionID, text: text)
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
