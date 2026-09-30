import SwiftUI

/// A short message over the bottom of the screen.
struct Toast: Identifiable, Equatable {
    enum Style: Equatable {
        case info, success, problem
    }

    let id = UUID()
    var text: String
    var style: Style = .info
    /// Offer a button to the Settings app (a permission is off).
    var opensSettings = false
}

/// The iPhone companion's state: the pairing, the Mac's live state (polled while the app is
/// in front), the request in flight, listening and speaking.
@MainActor
@Observable
final class AppModel {
    enum Link: Equatable {
        case connecting
        case online
        case unreachable(String)
    }

    private(set) var pairing: Pairing?
    private(set) var remote: RemoteState?
    private(set) var link: Link = .connecting
    private(set) var pending: PendingRequest?
    /// Approvals answered here that the Mac hasn't dropped yet.
    private(set) var answering: Set<String> = []
    private(set) var toast: Toast?
    private(set) var watchStatus = PhoneWatchBridge.Status()
    /// Why the pairing screen is showing again.
    var pairingNotice: String?
    /// The address of a pairing made before the companion spoke TLS, to pair again with.
    private(set) var previousAddress: String?
    /// A pairing link opened from outside the app (the Camera app read the Mac's QR code),
    /// waiting for the owner to confirm it.
    var offeredLink: PairingLink?
    var draft = ""
    private var speakSetting = true

    let speech = SpeechController()
    let voice = VoicePlayer()
    @ObservationIgnored private let watch = PhoneWatchBridge()

    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var toastTimer: Task<Void, Never>?
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var refreshes = 0
    @ObservationIgnored private var applied = 0
    /// Poll quickly until then (after starting the briefing or a routine on the Mac).
    @ObservationIgnored private var followUntil = Date.distantPast

    private static let speakKey = "speakReplies"
    static let whatsNext = "What's next on my calendar today?"

    init() {
        #if DEBUG
        if DebugLaunch.resetPairing { PairingStore.clear() }
        #endif
        if let stored = PairingStore.load() {
            if stored.isPinned {
                pairing = stored
            } else {
                // Paired before the Mac encrypted the connection: that token was only ever
                // sent in the clear, so pair again (to the Mac's certificate) instead.
                PairingStore.clear()
                previousAddress = stored.address
                pairingNotice = JarvisError.notPinned.message
            }
        }
        speakSetting = UserDefaults.standard.object(forKey: Self.speakKey) as? Bool ?? true
        #if DEBUG
        if let speak = DebugLaunch.speak { speakSetting = speak }
        #endif
        voice.onProblem = { [weak self] message in self?.show(message, style: .problem) }
        watch.onStatus = { [weak self] status in
            if self?.watchStatus != status { self?.watchStatus = status }
        }
        watch.activate()
        watch.push(pairing)  // on every launch, so the Watch always has the latest
    }

    // MARK: - What the screen shows

    var speakReplies: Bool {
        get { speakSetting }
        set {
            speakSetting = newValue
            UserDefaults.standard.set(newValue, forKey: Self.speakKey)
            if !newValue { voice.stop() }
        }
    }

    var visibleApprovals: [Approval] {
        (remote?.approvals ?? []).filter { !answering.contains($0.id) }
    }

    var transcript: [TranscriptLine] {
        Transcript.lines(state: remote, pending: pending)
    }

    var isOffline: Bool {
        if case .unreachable = link { return true }
        return false
    }

    /// Something is going on that Stop would stop.
    var isBusy: Bool {
        pending?.isOpen == true || remote?.state.isBusy == true || voice.isPlaying
    }

    var reactorMode: ReactorView.Mode {
        if speech.status == .listening || speech.status == .starting { return .listening }
        if isOffline { return .offline }
        if voice.isPlaying { return .speaking }
        if pending?.isOpen == true { return .thinking }
        switch remote?.state {
        case .thinking: return .thinking
        case .speaking: return .speaking
        case .listening: return .listening
        default: return .idle
        }
    }

    var caption: String {
        switch speech.status {
        case .starting: return "Starting"
        case .listening: return "Listening"
        case .finishing: return "Got it"
        case .idle: break
        }
        if isOffline { return "Offline" }
        if voice.isPlaying { return "Speaking" }
        if pending?.isOpen == true { return visibleApprovals.isEmpty ? "Thinking" : "Waiting for your OK" }
        if let state = remote?.state, state.isBusy { return "Mac is \(state.label.lowercased())" }
        if remote == nil { return "Connecting" }
        return "Tap to talk"
    }

    // MARK: - Lifecycle

    func setForeground(_ active: Bool) {
        foreground = active
        if active {
            restartPolling()
        } else {
            stopPolling()
            speech.cancel()
            voice.stop()  // no background audio: iOS would cut it off anyway
        }
    }

    // MARK: - Pairing

    /// Pairs over a connection pinned to `fingerprint`: from the Mac's QR code, or the one
    /// read from the connection and compared by the owner.
    func pair(at baseURL: URL, fingerprint: String, code: String, deviceName: String, macName: String?) async throws {
        let api = JarvisAPI(baseURL: baseURL, token: nil, fingerprint: fingerprint)
        let result = try await api.pair(code: code, deviceName: deviceName)
        let pairing = Pairing(
            baseURL: baseURL, token: result.token, macName: result.macName ?? macName, deviceName: deviceName,
            pairedAt: Date(), fingerprint: CertificatePin.normalize(fingerprint)
        )
        do {
            try PairingStore.save(pairing)
        } catch {
            show("Paired, but the Keychain wouldn’t keep it, so you’ll need to pair again next time.", style: .problem)
        }
        remote = nil
        pending = nil
        answering = []
        link = .connecting
        pairingNotice = nil
        previousAddress = nil
        self.pairing = pairing
        watch.push(pairing)
        restartPolling()
    }

    /// A URL the app was opened with: a pairing link from the Mac's QR code (asked about
    /// first), or a place in the app.
    func open(_ url: URL) {
        if let link = PairingLink(url.absoluteString) {
            offeredLink = link
        }
    }

    func acceptOfferedLink() async {
        guard let link = offeredLink else { return }
        offeredLink = nil
        do {
            try await pair(at: link.baseURL, fingerprint: link.fingerprint, code: link.code,
                           deviceName: UIDevice.current.name, macName: link.macName)
            Haptics.answered(negative: false)
        } catch {
            Haptics.failure()
            show((error as? JarvisError)?.errorDescription ?? error.localizedDescription, style: .problem)
        }
    }

    func changeAddress(to text: String) throws {
        guard var pairing else { return }
        guard let url = MacAddress.normalize(text) else { throw JarvisError.invalidAddress }
        guard url != pairing.baseURL else { return }
        pairing.baseURL = url
        try PairingStore.save(pairing)
        self.pairing = pairing
        remote = nil
        link = .connecting
        watch.push(pairing)
        restartPolling()
    }

    func unpair() {
        forget(notice: nil)
    }

    func resendToWatch() {
        watch.push(pairing)
        show("Sent to your Apple Watch.", style: .success)
    }

    // MARK: - Talking

    /// The reactor: start listening, or finish and send.
    func talk() {
        switch speech.status {
        case .idle:
            voice.stop()
            Haptics.talkStart()
            Task {
                do {
                    // Held only until it's called (or listening is cancelled).
                    try await speech.start { heard in self.heard(heard) }
                } catch let problem as SpeechController.Problem {
                    Haptics.failure()
                    show(problem.errorDescription ?? "Can’t listen right now.", style: .problem, opensSettings: problem.needsSettings)
                } catch {
                    Haptics.failure()
                    show("Couldn’t start listening: \(error.localizedDescription)", style: .problem)
                }
            }
        case .listening:
            speech.finish()
        case .starting:
            speech.cancel()
        case .finishing:
            break
        }
    }

    private func heard(_ text: String) {
        Haptics.talkStop()
        guard !text.isEmpty else {
            show("I didn’t catch that. Tap the reactor and try again.")
            return
        }
        Task { await send(text) }
    }

    func sendDraft() {
        let text = draft.trimmed
        guard !text.isEmpty else { return }
        draft = ""
        Task { await send(text) }
    }

    func send(_ raw: String) async {
        let text = raw.trimmed
        guard !text.isEmpty, let api = pairing?.api else { return }
        voice.stop()
        speech.cancel()
        let request = PendingRequest(question: text, history: remote?.history ?? [])
        pending = request
        restartPolling()
        do {
            let result = try await api.ask(text)
            guard pending?.id == request.id else { return }
            if result.done {
                pending?.phase = .answered(result.reply)
                announce(result.reply)
            } else {
                pending?.phase = .waiting  // it needs a yes, or is still going: polling picks it up
            }
        } catch JarvisError.unpaired {
            return lost()
        } catch JarvisError.timedOut {
            if pending?.id == request.id { pending?.phase = .waiting }
        } catch is CancellationError {
            return
        } catch {
            if pending?.id == request.id {
                pending?.phase = .failed((error as? JarvisError)?.errorDescription ?? error.localizedDescription)
                Haptics.failure()
            }
        }
        await refresh()
    }

    /// A reply to a request from this phone is in.
    private func announce(_ reply: String) {
        Haptics.reply()
        guard speakReplies, foreground, !reply.trimmed.isEmpty, let api = pairing?.api else { return }
        voice.speak(reply, using: api)
    }

    // MARK: - Approvals and commands

    func answer(_ approval: Approval, with choice: ApprovalChoice) async {
        guard let api = pairing?.api, !answering.contains(approval.id) else { return }
        answering.insert(approval.id)
        Haptics.answered(negative: choice.isNegative)
        do {
            if try await api.approve(id: approval.id, choice: choice.id) == false {
                show("That was already answered on the Mac.")
            }
        } catch JarvisError.unpaired {
            return lost()
        } catch {
            answering.remove(approval.id)
            Haptics.failure()
            show((error as? JarvisError)?.errorDescription ?? error.localizedDescription, style: .problem)
        }
        restartPolling()
    }

    func run(_ command: MacCommand) async {
        guard let api = pairing?.api else { return }
        Haptics.tap()
        if command == .stop {
            voice.stop()
            speech.cancel()
        }
        do {
            try await api.command(command)
            switch command {
            case .briefing:
                followUntil = Date().addingTimeInterval(45)
                show("Briefing on its way from your Mac.", style: .success)
            case .meetingStart:
                show("Taking meeting notes on your Mac.", style: .success)
            case .meetingStop:
                followUntil = Date().addingTimeInterval(20)
                show("Stopped. Jarvis is writing up the notes.", style: .success)
            case .runRoutine:
                followUntil = Date().addingTimeInterval(45)
                show("Routine started on your Mac.", style: .success)
            case .stop:
                break
            }
        } catch JarvisError.unpaired {
            return lost()
        } catch {
            Haptics.failure()
            show((error as? JarvisError)?.errorDescription ?? error.localizedDescription, style: .problem)
        }
        restartPolling()
    }

    // MARK: - Toasts

    func show(_ text: String, style: Toast.Style = .info, opensSettings: Bool = false) {
        let toast = Toast(text: text, style: style, opensSettings: opensSettings)
        self.toast = toast
        toastTimer?.cancel()
        toastTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(style == .problem ? 6 : 3.5))
            guard !Task.isCancelled, self?.toast?.id == toast.id else { return }
            self?.toast = nil
        }
    }

    func dismissToast() {
        toast = nil
    }

    // MARK: - Polling /api/state (foreground only)

    /// Every second while something is going on, every five otherwise.
    private var pollInterval: Double {
        let now = Date()
        if let pending, pending.isOpen, now.timeIntervalSince(pending.sentAt) < 300 { return 1 }
        if remote?.state.isBusy == true || !answering.isEmpty || now < followUntil { return 1 }
        return 5
    }

    private func restartPolling() {
        poller?.cancel()
        poller = nil
        guard foreground, pairing != nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(self.pollInterval))
            }
        }
    }

    private func stopPolling() {
        poller?.cancel()
        poller = nil
    }

    func refresh() async {
        guard let api = pairing?.api else { return }
        refreshes += 1
        let ticket = refreshes
        do {
            let state = try await api.state()
            guard ticket > applied, pairing?.token == api.token else { return }  // a newer answer won
            applied = ticket
            if link != .online { link = .online }
            apply(state)
        } catch JarvisError.unpaired {
            if pairing?.token == api.token { lost() }
        } catch is CancellationError {
        } catch {
            guard ticket > applied, pairing?.token == api.token else { return }
            applied = ticket
            let reason = (error as? JarvisError)?.message ?? error.localizedDescription
            if link != .unreachable(reason) { link = .unreachable(reason) }
        }
    }

    private func apply(_ state: RemoteState) {
        let known = Set((remote?.approvals ?? []).map(\.id))
        if remote != state { remote = state }
        let open = Set(state.approvals.map(\.id))
        if !answering.isSubset(of: open) { answering.formIntersection(open) }
        if state.approvals.contains(where: { !known.contains($0.id) }) {
            Haptics.attention()
        }
        if var request = pending {
            let finished = request.follow(state)
            if request.isSettled(by: state.history) {
                pending = nil  // the Mac's history now tells it
            } else if request != pending {
                pending = request
            }
            if let reply = finished { announce(reply) }
        }
        #if DEBUG
        runDebugHooks()
        #endif
    }

    private func lost() {
        forget(notice: "Jarvis on your Mac doesn’t recognise this iPhone anymore (it may have been removed there). Pair it again.")
    }

    private func forget(notice: String?) {
        stopPolling()
        speech.cancel()
        voice.stop()
        PairingStore.clear()
        pairing = nil
        remote = nil
        pending = nil
        answering = []
        link = .connecting
        pairingNotice = notice
        watch.push(nil)
    }

    // MARK: - Debug-only automation (see DebugLaunch)

    #if DEBUG
    @ObservationIgnored private var debugAsked = false
    @ObservationIgnored private var debugAnswered: Set<String> = []

    private func runDebugHooks() {
        if let ask = DebugLaunch.ask, !debugAsked {
            debugAsked = true
            draft = ask
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                sendDraft()
            }
        }
        if let choiceID = DebugLaunch.approve, let approval = visibleApprovals.first, !debugAnswered.contains(approval.id) {
            debugAnswered.insert(approval.id)
            Task {
                try? await Task.sleep(for: .seconds(5))
                await answer(approval, with: approval.choices.first { $0.id == choiceID } ?? approval.primary)
            }
        }
    }
    #endif
}
