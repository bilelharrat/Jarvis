import SwiftUI

/// The main screen: the wordmark, a status strip, the reactor (tap to talk) as the
/// centrepiece, approvals, the conversation, quick actions and a text field.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var typing: Bool
    @State private var showSettings = false
    @State private var showRoutines = false

    var body: some View {
        @Bindable var model = model
        GeometryReader { geometry in
            VStack(spacing: Space.s) {
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
                .padding(.horizontal, -Self.margin)  // a shelf, edge to edge
                if case .unreachable(let reason) = model.link {
                    ConnectionBanner(reason: reason) { Task { await model.refresh() } }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                reactor(height: geometry.size.height)
                if !model.visibleApprovals.isEmpty {
                    FittingScroll(maxHeight: geometry.size.height * 0.52) {
                        VStack(spacing: Space.s) {
                            ForEach(model.visibleApprovals) { approval in
                                ApprovalCard(approval: approval) { choice in
                                    Task { await model.answer(approval, with: choice) }
                                }
                                .transition(.asymmetric(insertion: .scale(scale: 0.94).combined(with: .opacity), removal: .opacity))
                            }
                        }
                    }
                    .layoutPriority(1)
                }
                TranscriptView(lines: model.transcript) { suggestion in
                    Task { await model.send(suggestion) }
                }
                .padding(.horizontal, -Self.margin)  // it brings its own margins
                if !typing {
                    QuickActions(meeting: model.remote?.meeting, busy: model.isBusy, perform: perform)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                InputBar(text: $model.draft, focused: $typing) {
                    typing = false  // make room for the reply (and any approval)
                    model.sendDraft()
                }
            }
            .padding(.horizontal, Self.margin)
            .padding(.bottom, Space.xxs)
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.32)))
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast, onDismiss: model.dismissToast)
                    .padding(.horizontal, Space.l)
                    .padding(.bottom, typing ? 72 : 150)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.84), value: model.visibleApprovals.map(\.id))
        .animation(.spring(response: 0.45, dampingFraction: 0.86), value: typing)
        .animation(.spring(response: 0.45, dampingFraction: 0.86), value: model.speech.isActive)
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
        HStack(spacing: Space.s) {
            VStack(alignment: .leading, spacing: 3) {
                Text("J.A.R.V.I.S.")
                    .font(.system(.title2, design: .serif).weight(.medium))
                    .tracking(2.4)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let pairing = model.pairing {
                    HStack(spacing: 6) {
                        Image(systemName: "desktopcomputer")
                            .font(.caption2.weight(.semibold))
                        Text(pairing.macLabel)
                            .font(.footnote.weight(.medium))
                            .lineLimit(1)
                    }
                    .foregroundStyle(Palette.titanium)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: Space.xs)
            roundButton(model.speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        label: model.speakReplies ? "Spoken replies on" : "Spoken replies off",
                        dim: !model.speakReplies) {
                model.speakReplies.toggle()
                Haptics.tap()
            }
            roundButton("gearshape.fill", label: "Settings") { showSettings = true }
        }
        .padding(.top, Space.xxs)
    }

    private func roundButton(_ symbol: String, label: String, dim: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.body.weight(.medium))
                .foregroundStyle(dim ? Palette.muted : Palette.ink)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(CircleGlassButtonStyle())
        .accessibilityLabel(label)
    }

    private func reactor(height: CGFloat) -> some View {
        VStack(spacing: Space.xs) {
            Button(action: model.talk) {
                ReactorView(mode: model.reactorMode, level: model.speech.level, size: orbSize(height))
            }
            .buttonStyle(ReactorButtonStyle())
            .accessibilityLabel(model.speech.status == .listening ? "Stop listening and send" : "Talk to Jarvis")
            .accessibilityValue(model.caption)
            .accessibilityHint(model.speech.status == .listening ? "" : "Starts listening. Stops by itself when you pause.")

            if model.visibleApprovals.isEmpty {  // the card below says it better
                Text(model.caption)
                    .font(.subheadline.weight(.medium))
                    .tracking(0.4)
                    .foregroundStyle(captionColor)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .accessibilityHidden(true)
            }

            if model.speech.isActive {
                Text(model.speech.transcript.isEmpty ? "Go ahead, I’m listening…" : model.speech.transcript)
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(model.speech.transcript.isEmpty ? Palette.muted : Palette.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Space.xxs)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .accessibilityLabel("Heard: \(model.speech.transcript)")
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// The page margin; the status shelf and the conversation run edge to edge and bring their own.
    static let margin: CGFloat = Space.m + 4

    private func orbSize(_ height: CGFloat) -> CGFloat {
        if typing { return 76 }
        if !model.visibleApprovals.isEmpty { return 96 }
        if model.speech.isActive { return min(280, max(160, height * 0.34)) }
        if model.isOffline { return min(190, max(112, height * 0.22)) }  // the banner above needs the room
        return min(250, max(136, height * 0.3))
    }

    private var captionColor: Color {
        switch model.reactorMode {
        case .offline: Palette.amber
        case .idle: Palette.muted
        default: Palette.ice
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
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
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
        // Up to its content (and the cap), but it gives way first when the screen is full
        // (the largest text sizes), so the controls below always stay on screen.
        .frame(maxHeight: min(max(contentHeight, 1), maxHeight))
    }
}
