import SwiftUI

/// A session's git, from the iPhone: the branch and what's changed, staging, a commit (its
/// message written for you if you like), push, a new branch, and its pull request (drafted,
/// opened, merged). Each is the Mac's own git panel at work.
struct CodeGitView: View {
    let sessionID: Int

    @Environment(AppModel.self) private var model
    @State private var git: JSONValue?
    @State private var pulls: [JSONValue] = []
    @State private var message = ""
    @State private var working: String?
    @State private var newBranch = ""
    @State private var askingBranch = false
    @State private var draft: PullDraft?
    @State private var confirmMerge: JSONValue?

    struct PullDraft: Identifiable {
        let id = UUID()
        var title: String
        var body: String
        var base: String
    }

    var body: some View {
        List {
            if let git, git["repo"]?.boolValue == false {
                Text("This project isn’t a git repository.").foregroundStyle(Palette.muted)
            } else if let git {
                branchSection(git)
                filesSection("Staged", git["staged"]?.arrayValue ?? [])
                filesSection("Not Staged", git["unstaged"]?.arrayValue ?? [], stageAll: true)
                commitSection(git)
                pullSection
                historySection(git["log"]?.arrayValue ?? [])
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
        .task { await load() }
        .alert("New Branch", isPresented: $askingBranch) {
            TextField("Name", text: $newBranch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Create") { run("branch", ["name": .string(newBranch), "create": .bool(true)]) }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $draft) { item in
            NavigationStack { pullSheet(item) }
        }
        .confirmationDialog("Merge this pull request?", isPresented: Binding(get: { confirmMerge != nil }, set: { if !$0 { confirmMerge = nil } }), titleVisibility: .visible) {
            Button("Merge", role: .destructive) {
                run("pr_merge", [:])
                confirmMerge = nil
            }
        }
    }

    // MARK: - Sections

    private func branchSection(_ git: JSONValue) -> some View {
        Section {
            HStack {
                Label(git["branch"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Detached", systemImage: "arrow.triangle.branch")
                    .font(.body.monospaced())
                Spacer()
                let ahead = git["ahead"]?.intValue ?? 0, behind = git["behind"]?.intValue ?? 0
                if ahead > 0 || behind > 0 {
                    Text("↑\(ahead) ↓\(behind)").font(.footnote.monospacedDigit()).foregroundStyle(Palette.muted)
                }
            }
            HStack {
                Button("Push", systemImage: "arrow.up.circle") { run("push", [:], timeout: 130) }
                    .disabled(working != nil)
                Spacer()
                Button("New Branch", systemImage: "plus") {
                    newBranch = ""
                    askingBranch = true
                }
            }
            .buttonStyle(.borderless)
            if let working {
                HStack(spacing: Space.xs) {
                    ProgressView().controlSize(.small)
                    Text(working).font(.footnote).foregroundStyle(Palette.muted)
                }
            }
        } header: {
            Text("Branch")
        }
    }

    @ViewBuilder
    private func filesSection(_ title: String, _ files: [JSONValue], stageAll: Bool = false) -> some View {
        if !files.isEmpty {
            Section {
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                    HStack(spacing: Space.s) {
                        Text(file["code"]?.stringValue ?? "M")
                            .font(.caption.monospaced().weight(.bold))
                            .foregroundStyle(Palette.cyan)
                            .frame(width: 18)
                        Text(file["path"]?.stringValue ?? "")
                            .font(.footnote.monospaced())
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
            } header: {
                HStack {
                    Text("\(title) (\(files.count))")
                    Spacer()
                    if stageAll {
                        Button("Stage All") { run("stage", ["all": .bool(true)]) }
                            .font(.caption)
                    } else {
                        Button("Unstage All") { run("stage", ["all": .bool(true), "unstage": .bool(true)]) }
                            .font(.caption)
                    }
                }
            }
        }
    }

    private func commitSection(_ git: JSONValue) -> some View {
        Section {
            TextField("Commit message", text: $message, axis: .vertical)
                .lineLimit(2...6)
            HStack {
                Button("Write It for Me", systemImage: "sparkles") { suggest() }
                    .disabled(working != nil)
                Spacer()
                Button("Commit", systemImage: "checkmark.circle.fill") {
                    run("commit", ["message": .string(message)], timeout: 95) { ok in if ok { message = "" } }
                }
                .disabled(message.trimmed.isEmpty || working != nil || (git["staged"]?.arrayValue ?? []).isEmpty)
            }
            .buttonStyle(.borderless)
        } header: {
            Text("Commit")
        } footer: {
            Text((git["staged"]?.arrayValue ?? []).isEmpty ? "Stage changes to commit them." : "Commits what’s staged, after the Mac checks it for secrets.")
        }
    }

    private var pullSection: some View {
        Section {
            if pulls.isEmpty {
                Button("Draft a Pull Request", systemImage: "arrow.triangle.pull") { draftPull() }
                    .disabled(working != nil)
            }
            ForEach(Array(pulls.enumerated()), id: \.offset) { _, pull in
                VStack(alignment: .leading, spacing: 4) {
                    Text("#\(pull["number"]?.intValue ?? 0) \(pull["title"]?.stringValue ?? "")")
                        .font(.body.weight(.medium))
                    Text([pull["state"]?.stringValue, pull["checks"]?.stringValue.map { "checks \($0)" }]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                    HStack {
                        if let link = pull["url"]?.stringValue, let url = URL(string: link) {
                            Link("Open on GitHub", destination: url).font(.footnote)
                        }
                        Spacer()
                        if pull["state"]?.stringValue == "open" {
                            Button("Merge") { confirmMerge = pull }.font(.footnote)
                        }
                    }
                }
            }
        } header: {
            Text("Pull Request")
        }
    }

    @ViewBuilder
    private func historySection(_ log: [JSONValue]) -> some View {
        if !log.isEmpty {
            Section("Recent Commits") {
                ForEach(Array(log.prefix(10).enumerated()), id: \.offset) { _, commit in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(commit["subject"]?.stringValue ?? "").font(.footnote)
                        Text("\(String((commit["sha"]?.stringValue ?? "").prefix(7))) · \(commit["author"]?.stringValue ?? "")")
                            .font(.caption2.monospaced())
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
        }
    }

    private func pullSheet(_ item: PullDraft) -> some View {
        PullDraftForm(draft: item) { title, body, base in
            draft = nil
            run("pr_open", ["title": .string(title), "body": .string(body), "base": .string(base), "draft": .bool(false)], timeout: 155)
        } onCancel: {
            draft = nil
        }
    }

    // MARK: - Talking to the Mac

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let state = try await api.codeAction("git", session: sessionID, timeout: 25)
            git = state["code_git"] ?? ["repo": false]
            let prs = try await api.codeAction("pr", session: sessionID, timeout: 35)
            pulls = (prs["code_prs"]?["items"]?.arrayValue ?? []).filter { $0["task_id"]?.intValue == sessionID }
        } catch {
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }

    private func run(_ action: String, _ fields: [String: JSONValue], timeout: TimeInterval = 45, then: ((Bool) -> Void)? = nil) {
        Task {
            guard let api = model.pairing?.api else { return }
            working = "Working…"
            defer { working = nil }
            do {
                let result = try await api.codeAction(action, session: sessionID, fields, timeout: timeout)
                if let state = result["code_git"] { git = state }
                if !result.said.isEmpty { model.show(result.said, style: result.ok ? .success : .problem) }
                (result.ok ? Haptics.answered(negative: false) : Haptics.failure())
                then?(result.ok)
                await load()
            } catch {
                Haptics.failure()
                if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            }
        }
    }

    private func suggest() {
        Task {
            guard let api = model.pairing?.api else { return }
            working = "Writing a message…"
            defer { working = nil }
            if let result = try? await api.codeAction("commit_message", session: sessionID, timeout: 95) {
                let text = result["code_git_message"]?["text"]?.stringValue ?? ""
                let note = result["code_git_message"]?["note"]?.stringValue ?? ""
                if !text.isEmpty { message = text } else if !note.isEmpty { model.show(note) }
            }
        }
    }

    private func draftPull() {
        Task {
            guard let api = model.pairing?.api else { return }
            working = "Drafting the pull request…"
            defer { working = nil }
            do {
                let result = try await api.codeAction("pr_draft", session: sessionID, timeout: 155)
                if let found = result["code_pr_draft"]?["draft"], found["title"] != nil {
                    draft = PullDraft(title: found["title"]?.stringValue ?? "", body: found["body"]?.stringValue ?? "",
                                      base: found["base"]?.stringValue ?? "main")
                } else {
                    let note = result["code_pr_draft"]?["note"]?.stringValue ?? result.said
                    model.show(note.isEmpty ? "Couldn’t draft a pull request." : note)
                    await load()
                }
            } catch {
                if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
            }
        }
    }
}

/// The pull request as drafted, to change before it's opened.
private struct PullDraftForm: View {
    let draft: CodeGitView.PullDraft
    let onOpen: (String, String, String) -> Void
    let onCancel: () -> Void
    @State private var title = ""
    @State private var text = ""
    @State private var base = ""

    var body: some View {
        Form {
            Section("Title") { TextField("Title", text: $title) }
            Section("Into") { TextField("Base branch", text: $base).textInputAutocapitalization(.never) }
            Section("Description") {
                TextField("Description", text: $text, axis: .vertical).lineLimit(6...20)
            }
        }
        .navigationTitle("Pull Request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            ToolbarItem(placement: .confirmationAction) {
                Button("Open") { onOpen(title, text, base) }.disabled(title.trimmed.isEmpty)
            }
        }
        .onAppear {
            title = draft.title
            text = draft.body
            base = draft.base
        }
    }
}
