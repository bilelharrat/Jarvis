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
    /// Requests kept while the Mac couldn't be reached (from here, Siri or the share sheet),
    /// oldest first.
    private(set) var queued: [OutboxItem] = []
    /// Why the pairing screen is showing again.
    var pairingNotice: String?
    /// The address of a pairing made before the companion spoke TLS, to pair again with.
    private(set) var previousAddress: String?
    /// A pairing link opened from outside the app (the Camera app read the Mac's QR code),
    /// waiting for the owner to confirm it.
    var offeredLink: PairingLink?
    /// A place to show (from a notification, a widget, a Live Activity); Home opens it.
    var destination: Destination?
    var draft = ""
    private var speakSetting = true

    let speech = SpeechController()
    let voice = VoicePlayer()
    @ObservationIgnored private let watch = PhoneWatchBridge()
    @ObservationIgnored private let outbox = Outbox.shared
    @ObservationIgnored private var draining = false
    /// The Mac said it has no push token for this device: sent again once per launch.
    @ObservationIgnored private var pushNudged = false
    @ObservationIgnored private var badge = -1

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
                PairingStore.shareWithExtensions(stored)
            } else {
                // Paired before the Mac encrypted the connection: that token was only ever
                // sent in the clear, so pair again (to the Mac's certificate) instead.
                PairingStore.clear()
                previousAddress = stored.address
                pairingNotice = JarvisError.notPinned.message
            }
        }
        queued = outbox.items()
        speakSetting = UserDefaults.standard.object(forKey: Self.speakKey) as? Bool ?? true
        #if DEBUG
        if let speak = DebugLaunch.speak { speakSetting = speak }
        #endif
        voice.onProblem = { [weak self] message in self?.show(message, style: .problem) }
        PushCoordinator.shared.onOpen = { [weak self] destination in self?.destination = destination }
        SnapshotPublisher.shared.onChange = { [weak self] snapshot in self?.watch.send(snapshot: snapshot) }
        LiveActivities.shared.resume()
        PushCoordinator.shared.onChange = { [weak self] in
            Task { await self?.refresh() }
        }
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
        Transcript.lines(state: remote, pending: pending, queued: queued)
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
            reloadQueue(sayExpired: true)
            restartPolling()
            Task { await HealthService.shared.sendIfDue() }
        } else {
            stopPolling()
            speech.cancel()
            voice.stop()  // no background audio: iOS would cut it off anyway
            if pairing != nil { BackgroundRefresh.schedule() }
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
        pushNudged = false
        // Approvals and heads-ups as notifications: ask now, the moment it makes sense.
        Task { await PushCoordinator.shared.enable() }
    }

    /// A URL the app was opened with: a pairing link from the Mac's QR code (asked about
    /// first), or a place in the app.
    func open(_ url: URL) {
        if let link = PairingLink(url.absoluteString) {
            offeredLink = link
        } else if let place = Destination(url: url), pairing != nil {
            destination = place
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

    /// `queuedAt`: when it was first asked, for a question that waited in the outbox.
    func send(_ raw: String, queuedAt: Date? = nil) async {
        let text = raw.trimmed
        guard !text.isEmpty, let api = pairing?.api else { return }
        voice.stop()
        speech.cancel()
        if isOffline {  // the last check couldn't reach the Mac: keep it for when it's back
            return keep(.ask(text, at: queuedAt ?? Date()))
        }
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
        } catch let error as JarvisError where error.neverDelivered {
            // It never got to the Mac: keep it (with when it was asked) until the Mac is back.
            if pending?.id == request.id { pending = nil }
            keep(.ask(text, at: queuedAt ?? request.sentAt))
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

    /// Answers an approval by what the answer means (from a Jarvis Code session, the Watch
    /// or a notification): the choice id comes from the card's own choices.
    @discardableResult
    func answer(approvalID: String, choices: [ApprovalChoice], with answer: ApprovalAnswer) async -> Bool {
        guard let api = pairing?.api, !answering.contains(approvalID) else { return false }
        answering.insert(approvalID)
        let sent = ApprovalResponse.choice(for: answer, choices: choices)
        Haptics.answered(negative: answer != .allow)
        do {
            if try await api.approve(id: approvalID, choice: sent.choice, feedback: sent.feedback) == false {
                show("That was already answered on the Mac.")
            }
            restartPolling()
            return true
        } catch {
            answering.remove(approvalID)
            if let problem = handle(error) {
                Haptics.failure()
                show(problem.errorDescription ?? problem.title, style: .problem)
            }
            return false
        }
    }

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
        if isOffline, command.keepsWhenOffline {
            return keep(.command(command, label: label(for: command)))
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
        } catch let error as JarvisError where error.neverDelivered && command.keepsWhenOffline {
            keep(.command(command, label: label(for: command)))
        } catch {
            Haptics.failure()
            show((error as? JarvisError)?.errorDescription ?? error.localizedDescription, style: .problem)
        }
        restartPolling()
    }

    /// Runs a routine now: the contract's endpoint, or the command an older Mac knows.
    func runRoutine(id: String, name: String) async {
        guard let api = pairing?.api else { return }
        Haptics.tap()
        if isOffline {
            return keep(.command(.runRoutine(id: id), label: "Routine · \(name)"))
        }
        do {
            _ = try await api.runRoutine(id: id)
            expectActivity()
            show("\(name) started on your Mac.", style: .success)
        } catch JarvisError.unsupported {
            await run(.runRoutine(id: id))
        } catch let error as JarvisError where error.neverDelivered {
            keep(.command(.runRoutine(id: id), label: "Routine · \(name)"))
        } catch {
            if let problem = handle(error) {
                Haptics.failure()
                show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }

    /// Something was started on the Mac: poll quickly for a while to show it.
    func expectActivity(for seconds: TimeInterval = 45) {
        followUntil = Date().addingTimeInterval(seconds)
        restartPolling()
    }

    /// A screen's request failed. A device the Mac no longer knows goes back to pairing
    /// (nil: nothing more to show); anything else comes back to be shown.
    @discardableResult
    func handle(_ error: Error) -> JarvisError? {
        if error is CancellationError { return nil }
        let problem = (error as? JarvisError) ?? .unreachable(error.localizedDescription)
        if problem == .unpaired {
            lost()
            return nil
        }
        return problem
    }

    private func label(for command: MacCommand) -> String {
        switch command {
        case .briefing: return "Brief me"
        case .runRoutine(let id):
            return (remote?.routines.first { $0.id == id }?.name).map { "Routine · \($0)" } ?? "A routine"
        case .stop: return "Stop"
        case .meetingStart: return "Take notes"
        case .meetingStop: return "Stop notes"
        }
    }

    // MARK: - The outbox (requests kept while the Mac was out of reach)

    /// Keeps a request to send when the Mac is back.
    func keep(_ item: OutboxItem, payload: Data? = nil) {
        do {
            try outbox.add(item, payload: payload)
            reloadQueue()
            Haptics.tap()
            show("Your Mac can’t be reached, so this waits here and goes when it’s back (within the hour).")
        } catch {
            Haptics.failure()
            show("Couldn’t keep that to send later: \(error.localizedDescription)", style: .problem)
        }
    }

    /// Don't send it after all.
    func discard(_ item: OutboxItem) {
        outbox.remove(item.id)
        reloadQueue()
    }

    /// Reads the queue again (Siri or the share sheet may have added to it).
    func reloadQueue(sayExpired: Bool = false) {
        let expired = outbox.pruneExpired()
        let items = outbox.items()
        if items != queued { queued = items }
        if sayExpired { tellExpired(expired) }
    }

    private func tellExpired(_ count: Int) {
        guard count > 0 else { return }
        show(count == 1
            ? "Your Mac was out of reach for an hour, so one waiting request wasn’t sent."
            : "Your Mac was out of reach for an hour, so \(count) waiting requests weren’t sent.")
    }

    /// Try the Mac now.
    func retryOutbox() async {
        await refresh()
    }

    /// The Mac answered: send what waited. Questions go through the conversation, one at a
    /// time, so their replies show (and are spoken) like any other; the rest go straight.
    private func startDrain() {
        guard !draining, !queued.isEmpty, pairing != nil else { return }
        draining = true
        Task {
            await drainOutbox()
            draining = false
        }
    }

    private func drainOutbox() async {
        guard let api = pairing?.api else { return }
        // Held through the question too: background refresh never sends it (or the rest) twice.
        _ = await outbox.exclusively { await self.drainHeld(using: api) }
    }

    private func drainHeld(using api: JarvisAPI) async {
        let sender = OutboxSender.sender(for: api)
        let report = await OutboxSender.pass(outbox) { item, body in
            item.kind == .ask ? .later : await sender(item, body)
        }
        reloadQueue()
        tellExpired(report.expired)
        if !report.sent.isEmpty {
            show(report.sent.count == 1 ? "Sent to your Mac: \(report.sent[0].label)" : "Sent \(report.sent.count) waiting requests to your Mac.", style: .success)
        } else if !report.refused.isEmpty {
            show("Your Mac didn’t take \(report.refused.count == 1 ? "a waiting request" : "\(report.refused.count) waiting requests").", style: .problem)
        }
        guard pending?.isOpen != true, let ask = outbox.items().first(where: { $0.kind == .ask }), let question = ask.question else { return }
        outbox.remove(ask.id)
        reloadQueue()
        await send(question, queuedAt: ask.createdAt)
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
            if let pairing { SnapshotPublisher.shared.publish(state, macName: pairing.macLabel) }
            if foreground { Task { await LiveActivities.shared.sync(state, api: api, inForeground: true) } }
            if !queued.isEmpty { startDrain() }
        } catch JarvisError.unpaired {
            if pairing?.token == api.token { lost() }
        } catch is CancellationError {
        } catch {
            guard ticket > applied, pairing?.token == api.token else { return }
            applied = ticket
            let reason = (error as? JarvisError)?.message ?? error.localizedDescription
            if link != .unreachable(reason) { link = .unreachable(reason) }
            SnapshotPublisher.shared.markOffline()
        }
    }

    private func apply(_ state: RemoteState) {
        if state.push?.registered == false, !pushNudged {
            pushNudged = true  // the Mac lost this device's token (or never had it)
            Task { await PushCoordinator.shared.sendToken(force: true) }
        }
        if state.pendingApprovals != badge {
            badge = state.pendingApprovals
            PushCoordinator.shared.setBadge(badge)
        }
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
        if let api = pairing?.api {  // the Mac stops pushing here (if it still knows this phone)
            Task { await PushCoordinator.shared.unregister(using: api) }
        }
        PushCoordinator.shared.setBadge(0)
        badge = -1
        stopPolling()
        speech.cancel()
        voice.stop()
        PairingStore.clear()
        outbox.removeAll()  // nothing kept for this Mac goes to another
        SnapshotPublisher.shared.clear()
        Task { await LiveActivities.shared.endAll() }
        LocationService.shared.turnOff()  // nothing to send to: off until turned on again
        HealthService.shared.turnOff()
        queued = []
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
