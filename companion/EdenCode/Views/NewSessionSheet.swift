import SwiftUI

/// A new session (G3, GNew.dc.html): ☰ and the project pill (which project; an isolated copy)
/// over the wallpaper, the Eden mark and "What should we build?", three starters, and Eden
/// chat's input bar (its drawer picks Manual or Accept edits and the model). Send starts it
/// (POST /new) and its session fills the screen.
struct NewSessionScreen: View {
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.drawerProgress) private var drawer
    @State private var project = ""
    @State private var text = ""
    @State private var mode = "ask"
    @State private var model: PhoneOptions.Model?
    @State private var isolated = false
    @State private var starting = false
    @State private var problem: String?
    @State private var dictation = Dictation()
    @State private var pictures: [CodeAttachment] = []
    /// The Mac's default mode is taken once; the owner's pick stays.
    @State private var modePicked = false

    /// The three starters: what they say, under it, and what they put in the input bar.
    static let starters: [(title: String, subtitle: String, prompt: String)] = [
        ("Fix a bug", "Exterminator Mode", "Find and fix this bug: "),
        ("Explain the project", "Where things live", "Explain this project: where things live and how the parts fit together."),
        ("Review changes", "Before you push", "Review my uncommitted changes before I push: bugs, risks, anything missing."),
    ]

    var body: some View {
        // The hero fills what's left between ☰ and the input bar and gives way when the
        // keyboard takes the room (it used to keep its height and push the input bar under
        // the keyboard): all of it, then just the question, then nothing.
        ViewThatFits(in: .vertical) {
            hero.frame(maxHeight: .infinity).offset(y: -20)
            heroTitle.frame(maxHeight: .infinity)
            Color.clear
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .movesForDrawer(drawer)
        .safeAreaBar(edge: .top, spacing: 0) {
            VStack(spacing: 10) {
                header
                if let problem = problem ?? store.problem {
                    ProblemBanner(text: problem).padding(.horizontal, 16)
                }
            }
            .padding(.top, 5)
            .padding(.bottom, 6)
            .movesForDrawer(drawer)
            .background { GBarScrim(edge: .top) }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            bottom.padding(.top, 6).movesForDrawer(drawer)
        }
        .background { EdenBackground() }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear(perform: pickDefaults)
        .onChange(of: store.options.projects) { _, _ in pickDefaults() }
        .onChange(of: dictation.heard) { _, heard in if !heard.isEmpty { text = heard } }
        .task { if store.options.projects.isEmpty { await store.refreshAll() } }
    }

    private func pickDefaults() {
        if project.isEmpty || !store.options.projects.contains(where: { $0.name == project }) {
            project = store.options.projects.first?.name ?? ""
        }
        if !modePicked {
            mode = CodeModes.phone.contains { $0.id == store.options.defaultMode } ? store.options.defaultMode : "ask"
        }
    }

    // MARK: - ☰ and the project

    private var header: some View {
        HStack(spacing: 10) {
            GCircleButton(glyph: MenuGlyph(), label: "Your sessions") { Keyboard.dismiss(); store.drawerOpen = true }
            Spacer(minLength: 0)
            projectPill
            Spacer(minLength: 0)
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 16)
    }

    private var projectPill: some View {
        Menu {
            Section("Project") {
                ForEach(store.options.projects) { p in
                    Button { project = p.name } label: {
                        if p.name == project {
                            Label(p.branch.isEmpty ? p.name : "\(p.name) · \(p.branch)", systemImage: "checkmark")
                        } else {
                            Text(p.branch.isEmpty ? p.name : "\(p.name) · \(p.branch)")
                        }
                    }
                }
            }
            Toggle("Work in an isolated copy", isOn: $isolated)
        } label: {
            HStack(spacing: 6) {
                Text(project.isEmpty ? "Choose a project" : project)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(EdenTheme.ink)
                    .lineLimit(1)
                if isolated {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 12, weight: .semibold)).foregroundStyle(EdenTheme.accent)
                }
                ChevronDown()
                    .stroke(EdenTheme.ink, style: StrokeStyle(lineWidth: 1.6))
                    .frame(width: 12, height: 12)
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            .contentShape(.capsule)
        }
        .gGlass(Capsule(), interactive: true)
        .accessibilityLabel("Project: \(project.isEmpty ? "none" : project)\(isolated ? ", in an isolated copy" : ""). Change")
    }

    // MARK: - What should we build?

    private var hero: some View {
        VStack(spacing: 12) {
            EdenMarkTile(size: 56, mark: 30, radius: 16, line: 1.9)
            Text("What should we build?")
                .font(.system(size: 26, weight: .bold))
                .tracking(-0.52)
                .foregroundStyle(EdenTheme.ink)
                .accessibilityAddTraits(.isHeader)
            Text(whereLine)
                .font(.system(size: 15))
                .foregroundStyle(EdenTheme.chevron)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 30)
        .frame(maxWidth: .infinity)
    }

    private var heroTitle: some View {
        Text("What should we build?")
            .font(.system(size: 22, weight: .bold))
            .foregroundStyle(EdenTheme.ink)
            .accessibilityAddTraits(.isHeader)
    }

    private var whereLine: String {
        let mac = store.current?.macLabel ?? "Mac"
        return project.isEmpty ? "On your \(mac)" : "In \(project), on your \(mac)"
    }

    // MARK: - Starters and the input bar

    private var bottom: some View {
        VStack(spacing: 18) {
            if text.trimmed.isEmpty { starters }
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
                working: starting,
                modeID: mode,
                modeLabel: CodeModes.name(mode),
                modelLabel: model?.name ?? store.options.modelName(store.options.defaultModel),
                modelRef: model?.ref ?? store.options.defaultModel,
                modes: store.options.modes,
                models: store.options.models,
                dictating: dictation.listening,
                talking: false,
                attachments: pictures.count,
                onSend: start,
                onSteer: start,
                onStop: {},
                onDictate: { Task { await dictation.toggle() } },
                onTalk: {},
                onMode: { mode = $0; modePicked = true },
                onModel: { model = $0 },
                onPictures: { items in Task { pictures += await SessionScreen.load(items) } }
            )
            .padding(.horizontal, 4)
            .disabled(starting)
        }
        .padding(.bottom, -4)
    }

    private var starters: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Self.starters, id: \.title) { starter in
                    Button { text = starter.prompt } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(starter.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                            Text(starter.subtitle).font(.system(size: 14)).foregroundStyle(EdenTheme.chevron)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .frame(width: 170, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(PressScale(scale: 0.97))
                    .gGlass(RoundedRectangle(cornerRadius: 18, style: .continuous), interactive: true)
                    .accessibilityLabel("\(starter.title). \(starter.subtitle)")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 20)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .padding(.vertical, -20)
    }

    private func start() {
        guard let backend = store.backend, !starting else { return }
        let prompt = text.trimmed
        guard !project.isEmpty else { problem = "Choose a project first."; return }
        guard !prompt.isEmpty || !pictures.isEmpty else { return }
        starting = true
        problem = nil
        dictation.stop()
        let attached = pictures
        Task {
            defer { starting = false }
            do {
                let ok = try await backend.newSession(directory: project, prompt: prompt.isEmpty ? "Look at these pictures." : prompt,
                                                      mode: mode, model: model?.ref, isolated: isolated)
                text = ""
                pictures = []
                if let id = ok.id, !attached.isEmpty { _ = try? await backend.send(id: id, text: "", pictures: attached) }
                await store.refreshHome()
                if let id = ok.id { store.open(session: id) }
            } catch {
                problem = (error as? JarvisError)?.message ?? error.localizedDescription
            }
        }
    }
}
