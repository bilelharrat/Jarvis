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

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ZStack {
                if model.transcript.isEmpty && !model.speech.isActive {
                    welcome
                        .transition(.opacity)
                } else {
                    TranscriptView(lines: model.transcript) { suggestion in
                        Task { await model.send(suggestion) }
                    }
                    .transition(.opacity)
                }
                if model.speech.isActive {
                    ListeningOverlay()
                        .transition(.opacity)
                }
            }
            .background(SpaceBackground(grouped: false))
            .safeAreaInset(edge: .top, spacing: 0) {
                if case .unreachable = model.link, model.pairing != nil {
                    offlineNote
                        .transition(.move(edge: .top).combined(with: .opacity))
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
            .navigationSubtitle(model.answererLabel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: model.visibleApprovals.map(\.id))
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: model.speech.isActive)
            .animation(.easeInOut(duration: 0.3), value: model.isOffline)
            .animation(.smooth, value: model.transcript.isEmpty)
            .sheet(isPresented: $showCamera) {
                NavigationStack { ShowJarvisView() }
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

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
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
                if !model.brain.turns.isEmpty {
                    Button("New Conversation on iPhone", systemImage: "square.and.pencil") { model.brain.clear() }
                }
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
                    ReactorView(mode: model.reactorMode, level: model.speech.level, size: 230)
                }
                .buttonStyle(OrbButtonStyle())
                .accessibilityLabel("Talk to Jarvis")
                .accessibilityHint("Starts listening. Stops by itself when you pause.")
                .padding(.top, Space.l)

                VStack(spacing: Space.xs) {
                    Text(Self.greeting())
                        .font(.largeTitle.weight(.bold))
                        .multilineTextAlignment(.center)
                    Text(model.caption)
                        .font(.body)
                        .foregroundStyle(Palette.ink2)
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
                Task { await model.refresh() }
            } else {
                showOutbox = true
            }
        } label: {
            HStack(spacing: Space.xs) {
                Image(systemName: "wifi.slash")
                Text(model.answersOnPhone ? "Mac offline · Jarvis is answering on this iPhone" : "Can’t reach your Mac · Tap to try again")
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
        .background(.ultraThinMaterial)
    }
}

/// The text field, "+" for the usual things, and the microphone, on Liquid Glass.
private struct Composer: View {
    @Environment(AppModel.self) private var model
    @Binding var text: String
    var typing: FocusState<Bool>.Binding
    let onCamera: () -> Void
    let onRoutines: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: Space.s) {
            HStack(alignment: .bottom, spacing: Space.s) {
                actionsMenu
                HStack(alignment: .bottom, spacing: Space.xs) {
                    TextField("Ask Jarvis", text: $text, axis: .vertical)
                        .lineLimit(1...5)
                        .focused(typing)
                        .submitLabel(.send)
                        .onSubmit(send)
                        .padding(.vertical, 11)
                        .padding(.leading, Space.m)
                    if !text.trimmed.isEmpty {
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
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: text.trimmed.isEmpty)
        }
    }

    private func send() {
        typing.wrappedValue = false
        model.sendDraft()
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

    private var actionsMenu: some View {
        Menu {
            Button("Brief Me", systemImage: "sparkles") { Task { await model.run(.briefing) } }
            Button("What’s Next?", systemImage: "calendar") { Task { await model.send(AppModel.whatsNext) } }
            Button("Show Jarvis", systemImage: "camera") { onCamera() }
            if model.pairing != nil && !model.answersOnPhone {
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
