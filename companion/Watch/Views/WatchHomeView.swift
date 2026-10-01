import SwiftUI

/// The Watch's one screen: approvals first, then the reactor (tap to dictate), the latest
/// reply (Digital Crown scrolls, spoken too), Brief me / Stop, and Speak replies.
struct WatchHomeView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 12) {
                        statusLine
                            .id(Self.top)
                        ForEach(model.approvals) { approval in
                            WatchApprovalCard(approval: approval) { choice in
                                Task { await model.answer(approval, with: choice) }
                            } onReason: { reason in
                                Task { await model.answer(approval, because: reason) }
                            }
                            .id(approval.id)
                            .transition(.scale(scale: 0.9).combined(with: .opacity))
                        }
                        talkButton
                        if let exchange = model.exchange {
                            WatchExchangeView(exchange: exchange)
                                .id(Self.exchange)
                        }
                        actions
                        SpeakRepliesToggle(voice: model.voice)
                            .padding(.top, 4)
                    }
                    .padding(.horizontal, 2)
                    .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.approvals.map(\.id))
                    .animation(.easeOut(duration: 0.25), value: model.exchange)
                }
                // Asked from the wrist: bring the reply into view. A new approval: show it.
                .onChange(of: model.pending?.id) { _, id in
                    guard id != nil else { return }
                    withAnimation { proxy.scrollTo(Self.exchange, anchor: .top) }
                }
                .onChange(of: model.exchange?.reply) { _, reply in
                    guard reply != nil, model.exchange?.question == model.lastAsked else { return }
                    withAnimation { proxy.scrollTo(Self.exchange, anchor: .top) }
                }
                .onChange(of: model.approvals.map(\.id)) { old, new in
                    guard let first = new.first, new.contains(where: { !old.contains($0) }) else { return }
                    withAnimation { proxy.scrollTo(first, anchor: .top) }
                }
            }
            .navigationTitle("JARVIS")
            .containerBackground(for: .navigation) { WatchBackground() }
        }
    }

    private static let top = "top"
    private static let exchange = "exchange"

    private var statusLine: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.offline ? Palette.amber : (model.remote?.state.isBusy == true ? Palette.cyan : Palette.online))
                .frame(width: 6, height: 6)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    HUDText(model.status, color: model.offline ? Palette.amber : Palette.ink2)
                    if let name = model.remote?.model {
                        HUDText("· \(name)")
                    }
                }
                HUDText(model.status, color: model.offline ? Palette.amber : Palette.ink2)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private var talkButton: some View {
        TextFieldLink(prompt: Text("Ask Jarvis")) {
            VStack(spacing: 6) {
                ReactorView(mode: model.reactorMode, size: 100)
                Text(model.pending?.isOpen == true ? "Thinking…" : "Ask Jarvis")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.cyan)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        } onSubmit: { text in
            Task { await model.ask(text) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Talk to Jarvis")
        .accessibilityHint("Dictate or scribble a request")
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button {
                Task { await model.run(.briefing) }
            } label: {
                Label("Brief me", systemImage: "sparkles")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .tint(Palette.cyan)
            Button {
                Task { await model.run(.stop) }
            } label: {
                Label("Stop", systemImage: "stop.fill")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .tint(Palette.danger)
        }
        .buttonStyle(.bordered)
        .labelStyle(.titleAndIcon)
    }
}

/// Speak replies, on the Watch: its own switch, remembered.
private struct SpeakRepliesToggle: View {
    @Bindable var voice: WatchVoice

    var body: some View {
        Toggle(isOn: $voice.enabled) {
            Label("Speak replies", systemImage: voice.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
                .font(.footnote)
        }
        .tint(Palette.cyan)
    }
}

/// The latest question and reply.
private struct WatchExchangeView: View {
    let exchange: WatchModel.Exchange

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HUDText("You")
                Text(exchange.question)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            VStack(alignment: .leading, spacing: 3) {
                HUDText(exchange.problem == nil ? "Jarvis" : "Not sent", color: exchange.problem == nil ? Palette.cyan : Palette.amber)
                if let problem = exchange.problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(Palette.amber)
                } else if let reply = exchange.reply {
                    Text(reply)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                } else if exchange.live {
                    HStack(spacing: 6) {
                        ProgressView()
                            .frame(width: 18, height: 18)
                        Text("Thinking…")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.spaceRaised))
        .accessibilityElement(children: .combine)
    }
}

struct WatchBackground: View {
    var body: some View {
        ZStack {
            Palette.space
            LinearGradient(colors: [Palette.core[3].opacity(0.35), .clear], startPoint: .top, endPoint: .center)
        }
    }
}
