import PhotosUI
import SwiftUI

/// The conversation: the orb when there's nothing yet (tap it, or say "Hey Jarvis"), then
/// the transcript; approvals and what Jarvis prepared (a text, a call) above a glass
/// composer with the microphone.
struct JarvisView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool
    @Binding var showOutbox: Bool
    @FocusState private var typing: Bool
    @State private var showCamera = false
    @State private var showRoutines = false
    @State private var showChats = false
    @State private var feedbackLine: TranscriptLine?
    @State private var feedbackText = ""

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ZStack {
                if model.transcript.isEmpty && !model.speech.isActive {
                    welcome
                        .transition(.opacity)
                } else {
                    TranscriptView(lines: model.transcript, onSuggestion: { suggestion in
                        Task { await model.send(suggestion) }
                    }, onAction: { action, line in
                        if action == .bad {
                            feedbackText = ""
                            feedbackLine = line
                        } else {
                            model.act(action, on: line)
                        }
                    })
                    .transition(.opacity)
                }
                if model.speech.isActive && !model.voiceMode {
                    ListeningOverlay()
                        .transition(.opacity)
                }
            }
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.28)))
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: Space.xs) {
                    Telemetry()
                    if case .unreachable = model.link, model.pairing != nil {
                        offlineNote
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: Space.s) {
                    if !model.visibleApprovals.isEmpty {
                        approvals
                    }
                    if !model.brain.actions.isEmpty {
                        ActionCards(actions: model.brain.actions) { done in
                            model.brain.actions.removeAll { $0 == done }
                        }
                    }
                    Composer(text: $model.draft, typing: $typing, onCamera: { showCamera = true }, onRoutines: { showRoutines = true })
                }
                .padding(.horizontal, Space.m)
                .padding(.bottom, Space.xs)
            }
            .navigationTitle("Jarvis")
            .navigationSubtitle(model.brain.study && model.answersOnPhone ? "Study mode" : model.brain.temporary && model.answersOnPhone ? "Temporary chat" : model.answererLabel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: model.visibleApprovals.map(\.id))
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: model.speech.isActive)
            .animation(.easeInOut(duration: 0.3), value: model.isOffline)
            .animation(.smooth, value: model.transcript.isEmpty)
            .sheet(isPresented: $showCamera) {
                NavigationStack { ShowJarvisView() }
            }
            .sheet(isPresented: $showChats) {
                NavigationStack { ChatsView() }
            }
            .fullScreenCover(isPresented: Binding(get: { model.voiceMode }, set: { if !$0 { model.endVoiceMode() } })) {
                VoiceModeView()
            }
            .sheet(item: $feedbackLine) { _ in
                NavigationStack { feedbackSheet }
                    .presentationDetents([.medium])
            }
            .sheet(isPresented: $showRoutines) {
                NavigationStack {
                    RoutinesView()
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showRoutines = false }
                            }
                        }
                }
            }
        }
    }

    // MARK: - Pieces

    /// What was wrong with a reply: kept as a correction, and tried again if asked.
    private var feedbackSheet: some View {
        Form {
            Section {
                TextField("What was wrong? (optional)", text: $feedbackText, axis: .vertical)
                    .lineLimit(2...6)
            } footer: {
                Text("Jarvis keeps it as a correction and won’t make that mistake again.")
            }
            Section {
                Button("Try Again with This") {
                    model.feedback(feedbackText, retry: true)
                    feedbackLine = nil
                }
                .disabled(!(feedbackLine?.onPhone ?? false))
                Button("Just Note It") {
                    model.feedback(feedbackText, retry: false)
                    feedbackLine = nil
                }
            }
        }
        .navigationTitle("Bad Response")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { feedbackLine = nil }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                showChats = true
            } label: {
                Image(systemName: "list.bullet")
            }
            .accessibilityLabel("Chats")
        }
        ToolbarItem(placement: .topBarLeading) {
            Button {
                model.speakReplies.toggle()
                Haptics.tap()
            } label: {
                Image(systemName: model.speakReplies ? "speaker.wave.2" : "speaker.slash")
                    .contentTransition(.symbolEffect(.replace))
            }
            .accessibilityLabel(model.speakReplies ? "Spoken replies on" : "Spoken replies off")
        }
        if model.isBusy {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.run(.stop) }
                } label: {
                    Image(systemName: "stop.fill")
                }
                .tint(.red)
                .accessibilityLabel("Stop")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("New Chat", systemImage: "square.and.pencil") { model.brain.newChat() }
                Button("Temporary Chat", systemImage: "eye.slash") { model.brain.newChat(temporary: true) }
                Toggle(isOn: Binding(get: { model.brain.study }, set: { model.brain.setStudy($0) })) {
                    Label("Study Mode", systemImage: "graduationcap")
                }
                Button("Chats", systemImage: "list.bullet") { showChats = true }
                if !model.queued.isEmpty {
                    Button("Waiting to Send (\(model.queued.count))", systemImage: "tray.and.arrow.up") { showOutbox = true }
                }
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("More")
        }
    }

    /// Nothing said yet: the orb, a greeting, and things to try.
    private var welcome: some View {
        ScrollView {
            VStack(spacing: Space.l) {
                Button(action: model.talk) {
                    ReactorView(mode: model.reactorMode, level: model.speech.level, size: 250)
                }
                .buttonStyle(OrbButtonStyle())
                .accessibilityLabel("Talk to Jarvis")
                .accessibilityHint("Starts listening. Stops by itself when you pause.")
                .padding(.top, Space.l)

                VStack(spacing: Space.xs) {
                    Text(Self.greeting())
                        .font(.largeTitle.weight(.bold))
                        .multilineTextAlignment(.center)
                    HUDText(model.caption, color: Palette.ring, tracking: 2)
                        .contentTransition(.opacity)
                }
                EmptyTranscript(suggestions: suggestions) { suggestion in
                    Task { await model.send(suggestion) }
                }
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.bottom, Space.l)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var suggestions: [String] {
        model.answersOnPhone
            ? ["What’s the weather?", "What’s on my calendar today?", "Set a timer for 10 minutes", "Remind me to call Pepper at 5"]
            : EmptyTranscript.defaultSuggestions
    }

    private var approvals: some View {
        ScrollView {
            VStack(spacing: Space.s) {
                ForEach(model.visibleApprovals) { approval in
                    ApprovalCard(approval: approval) { choice in
                        Task { await model.answer(approval, with: choice) }
                    } onReason: { reason in
                        Task { await model.answer(approvalID: approval.id, choices: approval.choices, with: .denyBecause(reason)) }
                    }
                    .transition(.asymmetric(insertion: .scale(scale: 0.95).combined(with: .opacity), removal: .opacity))
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 380)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var offlineNote: some View {
        Button {
            if model.queued.isEmpty {
                model.openMac(force: true)
                Task { await model.refresh() }
            } else {
                showOutbox = true
            }
        } label: {
            HStack(spacing: Space.xs) {
                Image(systemName: "wifi.slash")
                Text(model.answersOnPhone ? "Mac offline · Jarvis is answering on this iPhone" : model.macOpening ? "Opening JARVIS on your Mac…" : "Can’t reach your Mac · Tap to try again")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if !model.queued.isEmpty {
                    Text("\(model.queued.count) waiting")
                        .foregroundStyle(Palette.champagne)
                }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Palette.ink2)
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.xs)
            .glassEffect(.regular.interactive(), in: Capsule())
        }
        .buttonStyle(.plain)
        .padding(.top, Space.xxs)
        .padding(.bottom, Space.xs)
    }

    static func greeting(now: Date = Date()) -> String {
        switch Calendar.current.component(.hour, from: now) {
        case 5..<12: "Good morning."
        case 12..<18: "Good afternoon."
        default: "Good evening."
        }
    }
}

/// The orb presses in a little.
struct OrbButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// Listening: the orb large over a soft veil, with what's been heard so far.
private struct ListeningOverlay: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: Space.l) {
            Spacer()
            Button(action: model.talk) {
                ReactorView(mode: model.reactorMode, level: model.speech.level, size: 260)
            }
            .buttonStyle(OrbButtonStyle())
            .accessibilityLabel("Stop listening and send")
            Text(model.speech.transcript.isEmpty ? "Listening…" : model.speech.transcript)
                .font(.title2.weight(.semibold))
                .foregroundStyle(model.speech.transcript.isEmpty ? Palette.muted : Palette.ink)
                .multilineTextAlignment(.center)
                .lineLimit(5)
                .padding(.horizontal, Space.l)
                .contentTransition(.opacity)
                .accessibilityLabel("Heard: \(model.speech.transcript)")
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.4)))
    }
}

/// One line of telemetry under the title: who's answering, the link, the weather, what's
/// running. SF Mono caps, the way the suit reads it.
private struct Telemetry: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dot)
                .frame(width: 6, height: 6)
                .shadow(color: dot.opacity(0.8), radius: 3)
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                if index > 0 { HUDText("·", color: Palette.muted.opacity(0.6), tracking: 0) }
                HUDText(part, color: index == 0 ? Palette.ink2 : Palette.muted)
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private var dot: Color {
        if model.answersOnPhone { return Palette.cyan }
        return model.isOffline ? Palette.amber : Palette.online
    }

    private var parts: [String] {
        var parts = [model.answersOnPhone ? "iPhone" : (model.pairing?.macLabel ?? "Mac")]
        if model.pairing != nil, !model.answersOnPhone {
            parts.append(model.isOffline ? "Offline" : (model.remote?.state.label ?? "Linking"))
        } else {
            parts.append("Online")
        }
        if let weather = model.remote?.weather, let temp = weather.temp, !model.isOffline {
            parts.append("\(Int(temp.rounded()))\(weather.unit)")
        }
        let tasks = model.remote?.activeTasks.count ?? 0
        if tasks > 0 { parts.append("\(tasks) task\(tasks == 1 ? "" : "s")") }
        return parts
    }
}

/// The text field, "+" for the usual things (photos and screenshots among them), and the
/// microphone, on Liquid Glass. Pictures added wait above the field until sent.
private struct Composer: View {
    @Environment(AppModel.self) private var model
    @Binding var text: String
    var typing: FocusState<Bool>.Binding
    let onCamera: () -> Void
    let onRoutines: () -> Void
    @State private var showPhotos = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFiles = false

    private var hasCamera: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    private var canSend: Bool { !text.trimmed.isEmpty || !model.attachments.isEmpty || !model.documents.isEmpty }
    private var room: Int { max(Attachment.limit - model.attachments.count, 0) }

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: Space.xs) {
            if !model.attachments.isEmpty {
                AttachmentStrip(attachments: $model.attachments)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if !model.documents.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: Space.xs) {
                        ForEach(model.documents) { document in
                            DocumentChip(name: document.name) { model.documents.removeAll { $0.id == document.id } }
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .scrollIndicators(.hidden)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            bar
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.attachments)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.documents)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, .text, .rtf, .commaSeparatedText, .json, .html, .xml, .sourceCode],
                      allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            var read: [PickedDocument] = []
            for url in urls {
                switch PickedDocument.read(url) {
                case .success(let document): read.append(document)
                case .failure(let why): model.show(why.message, style: .problem)
                }
            }
            model.attach(documents: read)
        }
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: max(room, 1), selectionBehavior: .ordered, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { model.attach(await Attachment.load(items)) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in model.attach([image]) }
                .ignoresSafeArea()
        }
    }

    private var bar: some View {
        GlassEffectContainer(spacing: Space.s) {
            HStack(alignment: .bottom, spacing: Space.s) {
                actionsMenu
                HStack(alignment: .bottom, spacing: Space.xs) {
                    TextField(placeholder, text: $text, axis: .vertical)
                        .lineLimit(1...5)
                        .focused(typing)
                        .submitLabel(.send)
                        .onSubmit(send)
                        .padding(.vertical, 11)
                        .padding(.leading, Space.m)
                    if canSend {
                        Button(action: send) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 30))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, Color.accentColor)
                        }
                        .padding(.trailing, 6)
                        .padding(.bottom, 5)
                        .accessibilityLabel("Send to Jarvis")
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .frame(minHeight: 44)
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                micButton
                if !canSend { voiceModeButton.transition(.scale.combined(with: .opacity)) }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: canSend)
        }
    }

    private var placeholder: String {
        if !model.documents.isEmpty { return model.documents.count == 1 && model.attachments.isEmpty ? "Ask about this document" : "Ask about these" }
        if !model.attachments.isEmpty { return "Ask about \(model.attachments.count == 1 ? "this picture" : "these pictures")" }
        return model.brain.temporary && model.answersOnPhone ? "Ask Jarvis (temporary)" : "Ask Jarvis"
    }

    private func send() {
        typing.wrappedValue = false
        model.sendDraft()
    }

    /// What's on the clipboard: a screenshot just taken, an image copied in another app.
    private func pasteImages() {
        let images = UIPasteboard.general.images ?? []
        if images.isEmpty {
            model.show("There’s no picture on the clipboard.")
        } else {
            model.attach(images)
        }
    }

    private var micButton: some View {
        Button(action: model.talk) {
            Image(systemName: model.speech.isActive ? "waveform" : "mic.fill")
                .font(.title3.weight(.semibold))
                .symbolEffect(.variableColor.iterative, isActive: model.speech.status == .listening)
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
        }
        .glassEffect(.regular.tint(.accentColor).interactive(), in: Circle())
        .accessibilityLabel(model.speech.status == .listening ? "Stop listening and send" : "Talk to Jarvis")
    }

    private var voiceModeButton: some View {
        Button(action: model.startVoiceMode) {
            Image(systemName: "waveform")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Voice mode")
    }

    private var actionsMenu: some View {
        Menu {
            Section {
                Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                    .disabled(room == 0)
                if hasCamera {
                    Button("Take Photo", systemImage: "camera") { showCamera = true }
                        .disabled(room == 0)
                }
                Button("Files", systemImage: "doc") { showFiles = true }
                    .disabled(model.documents.count >= PickedDocument.limit)
                if UIPasteboard.general.hasImages {
                    Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImages() }
                        .disabled(room == 0)
                }
            }
            Button("Voice Mode", systemImage: "waveform") { model.startVoiceMode() }
            Button("Brief Me", systemImage: "sparkles") { Task { await model.run(.briefing) } }
            Button("What’s Next?", systemImage: "calendar") { Task { await model.send(AppModel.whatsNext) } }
            Button("Show Jarvis", systemImage: "camera.viewfinder") { onCamera() }
            if model.pairing != nil && model.brainMode != .phone {
                if model.remote?.meeting != nil {
                    Button("Stop Meeting Notes", systemImage: "stop.circle") { Task { await model.run(.meetingStop) } }
                } else {
                    Button("Take Meeting Notes", systemImage: "note.text") { Task { await model.run(.meetingStart(title: "Meeting")) } }
                }
                Button("Routines", systemImage: "bolt") { onRoutines() }
            }
        } label: {
            Image(systemName: "plus")
                .font(.title3.weight(.medium))
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("More actions")
    }
}
