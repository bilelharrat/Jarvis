import SwiftUI

/// The main screen: status strip, the reactor (tap to talk), approvals, the conversation,
/// quick actions and a text field.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var typing: Bool
    @State private var showSettings = false
    @State private var showRoutines = false

    var body: some View {
        @Bindable var model = model
        GeometryReader { geometry in
            VStack(spacing: 12) {
                topBar
                StatusStrip(
                    state: model.remote?.state,
                    offline: model.isOffline,
                    model: model.remote?.model,
                    next: model.remote?.nextEvent,
                    weather: model.remote?.weather,
                    taskCount: model.remote?.activeTasks.count ?? 0,
                    meeting: model.remote?.meeting
                )
                if case .unreachable(let reason) = model.link {
                    ConnectionBanner(reason: reason) { Task { await model.refresh() } }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                reactor(height: geometry.size.height)
                if !model.visibleApprovals.isEmpty {
                    FittingScroll(maxHeight: geometry.size.height * 0.5) {
                        VStack(spacing: 10) {
                            ForEach(model.visibleApprovals) { approval in
                                ApprovalCard(approval: approval) { choice in
                                    Task { await model.answer(approval, with: choice) }
                                }
                                .transition(.asymmetric(insertion: .scale(scale: 0.92).combined(with: .opacity), removal: .opacity))
                            }
                        }
                    }
                    .layoutPriority(1)
                }
                TranscriptView(lines: model.transcript) { suggestion in
                    Task { await model.send(suggestion) }
                }
                if !typing {
                    QuickActions(meeting: model.remote?.meeting, busy: model.isBusy, perform: perform)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                InputBar(text: $model.draft, focused: $typing) {
                    typing = false  // make room for the reply (and any approval)
                    model.sendDraft()
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.26)))
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast, onDismiss: model.dismissToast)
                    .padding(.horizontal, 20)
                    .padding(.bottom, typing ? 70 : 136)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.82), value: model.visibleApprovals.map(\.id))
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: typing)
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.speech.isActive)
        .animation(.easeInOut(duration: 0.3), value: model.isOffline)
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.toast)
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showRoutines) {
            RoutinesSheet(routines: model.remote?.routines ?? []) { routine in
                Task { await model.run(.runRoutine(id: routine.id)) }
            }
        }
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("J.A.R.V.I.S.")
                    .font(.headline.weight(.semibold))
                    .tracking(4)
                    .foregroundStyle(Palette.ink)
                if let pairing = model.pairing {
                    HUDText(pairing.macLabel)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer()
            roundButton(model.speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        label: model.speakReplies ? "Spoken replies on" : "Spoken replies off") {
                model.speakReplies.toggle()
                Haptics.tap()
            }
            roundButton("gearshape.fill", label: "Settings") { showSettings = true }
        }
        .padding(.top, 4)
    }

    private func roundButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.ink2)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 40, height: 40)
        }
        .buttonStyle(GlassButtonStyle(cornerRadius: 20))
        .accessibilityLabel(label)
    }

    private func reactor(height: CGFloat) -> some View {
        VStack(spacing: 10) {
            Button(action: model.talk) {
                ReactorView(mode: model.reactorMode, level: model.speech.level, size: orbSize(height))
            }
            .buttonStyle(ReactorButtonStyle())
            .accessibilityLabel(model.speech.status == .listening ? "Stop listening and send" : "Talk to Jarvis")
            .accessibilityValue(model.caption)
            .accessibilityHint(model.speech.status == .listening ? "" : "Starts listening. Stops by itself when you pause.")

            HUDText(model.caption, color: captionColor, tracking: 2.6)
                .contentTransition(.opacity)
                .accessibilityHidden(true)

            if model.speech.isActive {
                Text(model.speech.transcript.isEmpty ? "Go ahead, I’m listening…" : model.speech.transcript)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(model.speech.transcript.isEmpty ? Palette.muted : Palette.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .accessibilityLabel("Heard: \(model.speech.transcript)")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func orbSize(_ height: CGFloat) -> CGFloat {
        if typing { return 72 }
        if !model.visibleApprovals.isEmpty { return 92 }
        if model.speech.isActive { return min(240, max(150, height * 0.3)) }
        return min(210, max(128, height * 0.25))
    }

    private var captionColor: Color {
        switch model.reactorMode {
        case .offline: Palette.amber
        case .idle: Palette.muted
        default: Palette.cyan
        }
    }

    private func perform(_ action: QuickAction) {
        switch action {
        case .briefing: Task { await model.run(.briefing) }
        case .whatsNext: Task { await model.send(AppModel.whatsNext) }
        case .notesStart: Task { await model.run(.meetingStart(title: "Meeting")) }
        case .notesStop: Task { await model.run(.meetingStop) }
        case .routines: showRoutines = true
        case .stop: Task { await model.run(.stop) }
        }
    }
}

/// The reactor presses in a little.
private struct ReactorButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// A scroll view as tall as its content, up to a limit.
private struct FittingScroll<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder var content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            content
                .padding(.vertical, 1)  // keeps the cards' hairlines inside the clip
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        .frame(height: min(max(contentHeight, 1), maxHeight))
    }
}
