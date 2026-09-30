import SwiftUI
import WatchKit

/// The Watch app's state. It talks to the Mac directly (Wi‑Fi, cellular, or through the
/// iPhone) with the pairing the iPhone handed over, and polls only while it's in front.
@MainActor
@Observable
final class WatchModel {
    /// The latest question and its reply, for the main screen.
    struct Exchange: Equatable {
        var question: String
        var reply: String?
        var live: Bool
        var problem: String?
    }

    private(set) var pairing: Pairing?
    private(set) var remote: RemoteState?
    private(set) var pending: PendingRequest?
    private(set) var answering: Set<String> = []
    private(set) var offline = false
    private(set) var notice: String?
    /// The last thing asked from the wrist, so its reply can be brought into view.
    private(set) var lastAsked: String?

    @ObservationIgnored private let bridge = WatchSessionBridge()
    /// Spoken replies to what was asked here.
    let voice = WatchVoice()
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var active = false
    @ObservationIgnored private var frontmost = false
    @ObservationIgnored private var refreshes = 0
    @ObservationIgnored private var applied = 0
    @ObservationIgnored private var buzzed: Set<String> = []

    init() {
        if let stored = PairingStore.load() {
            if stored.isPinned {
                pairing = stored
            } else {
                PairingStore.clear()  // from before TLS: the iPhone sends a pinned one after it pairs again
            }
        }
        bridge.onUpdate = { [weak self] update in self?.receive(update) }
        bridge.onSnapshot = { snapshot in
            // The iPhone's view of the Mac, when it's newer than the Watch's own.
            if (SnapshotStore.shared.read()?.updatedAt ?? .distantPast) < snapshot.updatedAt {
                SnapshotPublisher.shared.adopt(snapshot)
            }
        }
        bridge.activate()
    }

    var approvals: [Approval] {
        (remote?.approvals ?? []).filter { !answering.contains($0.id) }
    }

    var reactorMode: ReactorView.Mode {
        if offline { return .offline }
        if pending?.isOpen == true { return .thinking }
        switch remote?.state {
        case .thinking: return .thinking
        case .speaking: return .speaking
        case .listening: return .listening
        default: return .idle
        }
    }

    var status: String {
        if offline { return "Offline" }
        guard let remote else { return "Connecting" }
        return remote.state.label
    }

    var exchange: Exchange? {
        if let pending {
            switch pending.phase {
            case .answered(let reply):
                return Exchange(question: pending.question, reply: reply.isEmpty ? "Done." : reply, live: false)
            case .failed(let message):
                return Exchange(question: pending.question, reply: nil, live: false, problem: message)
            case .sending, .waiting:
                let streaming = remote.flatMap { pending.streaming(in: $0) }
                return Exchange(question: pending.question, reply: streaming?.isEmpty == false ? streaming : nil, live: true)
            }
        }
        guard let remote, let last = remote.history.lastIndex(where: { $0.role == .user }) else { return nil }
        let question = remote.history[last].text
        if let reply = remote.history[(last + 1)...].first(where: { $0.role == .assistant })?.text {
            return Exchange(question: question, reply: reply, live: false)
        }
        let live = remote.state.isBusy && remote.turn.user == question
        return Exchange(question: question, reply: live && !remote.turn.reply.isEmpty ? remote.turn.reply : nil, live: live)
    }

    // MARK: - Lifecycle

    /// Polls only while active (wrist raised). A reply still finishes speaking with the
    /// wrist down, while the app is frontmost, and stops when the app leaves.
    func setPhase(_ phase: ScenePhase) {
        frontmost = phase != .background
        if !frontmost { voice.stop() }
        setActive(phase == .active)
    }

    private func setActive(_ isActive: Bool) {
        active = isActive
        if isActive {
            if pairing == nil { bridge.requestPairing() }
            restartPolling()
            #if DEBUG
            Task { await debugPair() }
            #endif
        } else {
            poller?.cancel()
            poller = nil
            if pairing != nil { WatchRefresh.schedule() }
        }
    }

    func checkPhone() {
        notice = "Asking your iPhone…"
        bridge.requestPairing()
        Task {
            try? await Task.sleep(for: .seconds(4))
            if pairing == nil { notice = "Open J.A.R.V.I.S. on your iPhone, then try again." }
        }
    }

    private func receive(_ update: WatchLink.Update) {
        #if DEBUG
        if DebugLaunch.server != nil { return }  // paired straight to a test server
        #endif
        switch update {
        case .paired(let new):
            guard new.token != pairing?.token || new.baseURL != pairing?.baseURL else { return }
            try? PairingStore.save(new)
            pairing = new
            remote = nil
            pending = nil
            offline = false
            notice = nil
            restartPolling()
        case .unpaired:
            if pairing != nil { forget() }
        case .nothing:
            break
        }
    }

    private func forget() {
        voice.stop()
        PairingStore.clear()
        SnapshotPublisher.shared.clear()
        pairing = nil
        remote = nil
        pending = nil
        answering = []
        poller?.cancel()
        poller = nil
    }

    // MARK: - Asking

    func ask(_ raw: String) async {
        let text = raw.trimmed
        guard !text.isEmpty, let api = pairing?.api else { return }
        let request = PendingRequest(question: text, history: remote?.history ?? [])
        pending = request
        lastAsked = text
        WKInterfaceDevice.current().play(.start)
        restartPolling()
        do {
            let result = try await api.ask(text)
            guard pending?.id == request.id else { return }
            if result.done {
                pending?.phase = .answered(result.reply)
                WKInterfaceDevice.current().play(.success)
                speak(result.reply)
            } else {
                pending?.phase = .waiting
            }
        } catch JarvisError.unpaired {
            return forget()
        } catch JarvisError.timedOut {
            if pending?.id == request.id { pending?.phase = .waiting }
        } catch is CancellationError {
            return
        } catch {
            if pending?.id == request.id {
                pending?.phase = .failed((error as? JarvisError)?.title ?? error.localizedDescription)
            }
            WKInterfaceDevice.current().play(.failure)
        }
        await refresh()
    }

    /// A reply to something asked here.
    private func speak(_ reply: String) {
        guard frontmost, let api = pairing?.api else { return }
        voice.speak(reply, using: api)
    }

    // MARK: - Approvals

    func answer(_ approval: Approval, with choice: ApprovalChoice) async {
        await send(approval, choice: choice.id, feedback: nil, haptic: choice.isNegative ? .directionDown : .success)
    }

    /// "No, because…", dictated or scribbled on the wrist: the card's no, with the reason.
    func answer(_ approval: Approval, because reason: String) async {
        let sent = ApprovalResponse.choice(for: .denyBecause(reason), choices: approval.choices)
        await send(approval, choice: sent.choice, feedback: sent.feedback, haptic: .directionDown)
    }

    private func send(_ approval: Approval, choice: String, feedback: String?, haptic: WKHapticType) async {
        guard let api = pairing?.api, !answering.contains(approval.id) else { return }
        answering.insert(approval.id)
        WKInterfaceDevice.current().play(haptic)
        do {
            _ = try await api.approve(id: approval.id, choice: choice, feedback: feedback)
        } catch JarvisError.unpaired {
            return forget()
        } catch {
            answering.remove(approval.id)
            WKInterfaceDevice.current().play(.failure)
        }
        restartPolling()
    }

    // MARK: - Commands

    func run(_ command: MacCommand) async {
        guard let api = pairing?.api else { return }
        WKInterfaceDevice.current().play(.click)
        if command == .stop { voice.stop() }
        do {
            try await api.command(command)
        } catch JarvisError.unpaired {
            return forget()
        } catch {
            WKInterfaceDevice.current().play(.failure)
            if case .unreachable = error as? JarvisError { offline = true }
        }
        restartPolling()
    }

    // MARK: - Polling (only while the app is in front)

    private var pollInterval: Double {
        if let pending, pending.isOpen, Date().timeIntervalSince(pending.sentAt) < 300 { return 1.5 }
        if remote?.state.isBusy == true || !answering.isEmpty { return 1.5 }
        return 5
    }

    private func restartPolling() {
        poller?.cancel()
        poller = nil
        guard active, pairing != nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(self.pollInterval))
            }
        }
    }

    func refresh() async {
        guard let api = pairing?.api else { return }
        refreshes += 1
        let ticket = refreshes
        do {
            let state = try await api.state()
            guard ticket > applied, pairing?.token == api.token else { return }
            applied = ticket
            if offline { offline = false }
            apply(state)
            if let pairing { SnapshotPublisher.shared.publish(state, macName: pairing.macLabel) }
        } catch JarvisError.unpaired {
            if pairing?.token == api.token { forget() }
        } catch is CancellationError {
        } catch {
            guard ticket > applied else { return }
            applied = ticket
            if !offline { offline = true }
            SnapshotPublisher.shared.markOffline()
        }
    }

    private func apply(_ state: RemoteState) {
        if remote != state { remote = state }
        let open = Set(state.approvals.map(\.id))
        if !answering.isSubset(of: open) { answering.formIntersection(open) }
        let fresh = open.subtracting(buzzed)
        if !fresh.isEmpty {
            buzzed.formUnion(fresh)
            WKInterfaceDevice.current().play(.notification)
        }
        if var request = pending {
            let finished = request.follow(state)
            if request.isSettled(by: state.history) {
                pending = nil  // the Mac's history shows it now
            } else if request != pending {
                pending = request
            }
            if let finished {
                WKInterfaceDevice.current().play(.success)
                if !finished.trimmed.isEmpty { speak(finished) }
            }
        }
        #if DEBUG
        runDebugHooks()
        #endif
    }

    // MARK: - Debug-only (see DebugLaunch)

    #if DEBUG
    @ObservationIgnored private var debugAsked = false

    /// Pairs straight to a test server, skipping the iPhone.
    private func debugPair() async {
        guard pairing == nil, let server = DebugLaunch.server, let code = DebugLaunch.code,
              let url = MacAddress.normalize(server) else { return }
        do {
            let fingerprint = try await JarvisAPI.probeFingerprint(at: url)
            let result = try await JarvisAPI(baseURL: url, token: nil, fingerprint: fingerprint).pair(code: code, deviceName: "Apple Watch (test)")
            let pairing = Pairing(
                baseURL: url, token: result.token, macName: result.macName ?? "Test Mac", deviceName: "Apple Watch",
                pairedAt: Date(), fingerprint: fingerprint
            )
            try? PairingStore.save(pairing)
            self.pairing = pairing
            restartPolling()
        } catch {
            notice = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    @ObservationIgnored private var debugAnswered: Set<String> = []

    private func runDebugHooks() {
        if let text = DebugLaunch.ask, !debugAsked {
            debugAsked = true
            Task {
                try? await Task.sleep(for: .seconds(1))
                await ask(text)
            }
        }
        if let choiceID = DebugLaunch.approve, let approval = approvals.first, !debugAnswered.contains(approval.id) {
            debugAnswered.insert(approval.id)
            Task {
                try? await Task.sleep(for: .seconds(6))
                await answer(approval, with: approval.choices.first { $0.id == choiceID } ?? approval.primary)
            }
        }
        if let reason = DebugLaunch.reason, let approval = approvals.first, !debugAnswered.contains(approval.id) {
            debugAnswered.insert(approval.id)
            Task {
                try? await Task.sleep(for: .seconds(6))
                await answer(approval, because: reason)
            }
        }
    }
    #endif
}
