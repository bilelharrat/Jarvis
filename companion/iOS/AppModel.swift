import AVFoundation
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
    /// Pictures waiting in the composer (photos, screenshots), sent with the draft.
    var attachments: [Attachment] = []
    /// Documents waiting in the composer (PDFs, text files), sent with the draft.
    var documents: [PickedDocument] = []
    /// Small copies of the pictures sent to the Mac this session, by question.
    private(set) var sentPictures: [String: [Data]] = [:]
    private var speakSetting = true

    let speech = SpeechController()
    let voice = VoicePlayer()
    /// Jarvis on the iPhone itself: answers when there's no Mac, the Mac can't be reached,
    /// or the owner chose it.
    let brain = LocalBrain()
    /// Listens for "Hey Jarvis" while the owner has it on.
    let wake = WakeWordListener()
    /// Which Jarvis answers (Settings).
    private(set) var brainMode: BrainMode = .automatic
    /// A Claude or Gemini API key is saved for Jarvis on the iPhone.
    private(set) var hasPhoneKey = false
    /// Apple's own model can answer on this iPhone (Apple Intelligence on, the model ready):
    /// looked at again each time the app comes to the front.
    private(set) var hasAppleBrain = false
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
    /// When this phone last asked the Mac to open JARVIS (at most once a minute).
    @ObservationIgnored private var wokeAt = Date.distantPast
    /// The Mac said it's opening JARVIS, and isn't back yet.
    private(set) var macOpening = false
    /// The Mac is reached through the Jarvis relay (its own address can't be).
    private(set) var viaRelay = false
    /// Settings › Account, over everything (an Upgrade button, a link code from the Camera).
    var showAccount = false
    /// A Mac's link code opened from outside the app (`jarvis-link://…`), for the account
    /// screen to look up.
    var pendingLinkCode: String?

    private static let speakKey = "speakReplies"
    static let wakeKey = "wake.enabled"
    static let wakeBackgroundKey = "wake.background"
    static let whatsNext = "What's next on my calendar today?"
    static let phoneBriefing = "Brief me: what's on my calendar today, the weather, and my open reminders."

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
        brainMode = UserDefaults.standard.string(forKey: BrainSettings.modeKey).flatMap(BrainMode.init) ?? .automatic
        hasPhoneKey = BrainSettings.hasAnyKey
        hasAppleBrain = AppleClient.isAvailable
        brain.tools.mac = pairing?.api
        wake.onWake = { [weak self] in self?.wakeHeard() }
        wake.onCommand = { [weak self] command in
            Haptics.attention()
            guard OwnerLock.allows else {  // the iPhone is locked: it may not be the owner
                self?.voice.speakLocally(OwnerLock.refusal)
                return
            }
            Task { await self?.send(command, spoken: true) }
        }
        voice.onFinish = { [weak self] in self?.resumeWakeWord() }
        NotificationCenter.default.addObserver(forName: ListenRequest.notification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.takeListenRequest() }
        }
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
        // The Jarvis account (optional): the relay route to the Mac, purchases, push, sync.
        MacRoute.router = MacRouter.shared
        Task { await MacRouter.shared.reload() }
        AccountStore.shared.start()
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

    func setBrainMode(_ mode: BrainMode) {
        brainMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: BrainSettings.modeKey)
    }

    func setPhoneKey(_ key: String?, for provider: BrainProvider = .claude) throws {
        try BrainSettings.setKey(key, for: provider)
        hasPhoneKey = BrainSettings.hasAnyKey
    }

    /// Copies the Mac's Claude and Gemini API keys into this iPhone's Keychain, so Jarvis
    /// answers here with them while the Mac can't be reached. What happened, for the screen.
    func copyMacKeys() async -> String {
        guard let api = pairing?.api else { return "Pair your Mac first." }
        let keys: [String: String]
        do {
            keys = try await api.brainKeys()
        } catch {
            return (error as? JarvisError)?.message ?? error.localizedDescription
        }
        var copied: [String] = []
        for provider in BrainProvider.keyed {
            guard let key = keys[provider.rawValue]?.trimmed, !key.isEmpty, provider.problem(with: key) == nil else { continue }
            do {
                try setPhoneKey(key, for: provider)
                copied.append(provider.title)
            } catch {
                return "The Keychain wouldn’t keep the \(provider.title) key: \(error.localizedDescription)"
            }
        }
        guard !copied.isEmpty else {
            return "Your Mac has no Claude or Gemini API key saved (add one in JARVIS on your Mac, Settings › Models)."
        }
        return "Copied your Mac’s \(copied.joined(separator: " and ")) key. Jarvis answers here with it when your Mac can’t be reached."
    }

    /// Jarvis on the iPhone can answer: with a Claude or Gemini key, the AI included with a
    /// Jarvis account, or Apple's own model.
    var phoneCanAnswer: Bool { hasPhoneKey || hasAppleBrain || AccountStore.shared.isSignedIn }

    /// Jarvis Plus answers here as readily as the owner's own key would.
    private var phoneHasPlus: Bool { AccountStore.shared.isSignedIn && AccountStore.shared.account?.plan.isPlus == true }

    /// The next request is answered on the iPhone: there's no Mac, the Mac can't be reached
    /// (whatever the mode), the owner chose the iPhone, or (automatically) there's a Claude or
    /// Gemini key, so the iPhone answers what it can and hands the rest to the Mac.
    var answersOnPhone: Bool {
        brainMode.answersOnPhone(paired: pairing != nil, hasKey: hasPhoneKey || phoneHasPlus, canAnswer: phoneCanAnswer, macAway: isOffline)
    }

    /// The Mac's feature screens (from /api/state).
    var macFeatures: Set<String> { Set(remote?.features ?? []) }

    /// Nothing to talk to yet: no Mac and no key for the iPhone.
    var needsSetup: Bool {
        #if DEBUG
        if DebugLaunch.skipSetup { return false }
        #endif
        return pairing == nil && !phoneCanAnswer
    }

    /// Who's answering, for the screen.
    var answererLabel: String {
        if answersOnPhone { return "On this iPhone" }
        return pairing?.macLabel ?? "Your Mac"
    }

    var visibleApprovals: [Approval] {
        (remote?.approvals ?? []).filter { !answering.contains($0.id) }
    }

    var transcript: [TranscriptLine] {
        let mac = pairing == nil ? [] : Transcript.lines(state: remote, pending: pending, queued: queued, pictures: sentPictures)
        let phone = brain.turns.map { turn in
            TranscriptLine(
                id: "local:\(turn.id)",
                kind: turn.role == .user ? .user : turn.role == .jarvis ? .jarvis : .problem,
                text: turn.text, time: turn.time, live: turn.live, onPhone: true, activity: turn.activity,
                pictures: turn.pictures, files: turn.files, offersUpgrade: turn.offersUpgrade
            )
        }
        guard !mac.isEmpty, !phone.isEmpty else { return mac + phone }
        // Both: in the order they were said (a live line counts as now).
        return (mac + phone).enumerated().sorted { a, b in
            let ta = a.element.live ? Date.distantFuture : (a.element.time ?? .distantPast)
            let tb = b.element.live ? Date.distantFuture : (b.element.time ?? .distantPast)
            return ta == tb ? a.offset < b.offset : ta < tb
        }.map(\.element)
    }

    var isOffline: Bool {
        if case .unreachable = link { return true }
        return false
    }

    /// Something is going on that Stop would stop.
    var isBusy: Bool {
        pending?.isOpen == true || remote?.state.isBusy == true || voice.isPlaying || brain.isWorking
    }

    var reactorMode: ReactorView.Mode {
        if speech.status == .listening || speech.status == .starting { return .listening }
        if voice.isPlaying { return .speaking }
        if brain.isWorking { return .thinking }
        if isOffline && !answersOnPhone { return .offline }
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
        if voice.isPlaying { return "Speaking" }
        if brain.isWorking { return "Thinking" }
        if isOffline && !answersOnPhone { return "Mac offline" }
        if pending?.isOpen == true { return visibleApprovals.isEmpty ? "Thinking" : "Waiting for your OK" }
        if !answersOnPhone, let state = remote?.state, state.isBusy { return "Mac is \(state.label.lowercased())" }
        if !answersOnPhone, remote == nil { return "Connecting" }
        return wake.isListening ? "Say “Hey Jarvis”, or tap" : "Tap to talk"
    }

    // MARK: - Lifecycle

    func setForeground(_ active: Bool) {
        foreground = active
        SyncEngine.shared.setActive(active && AccountStore.shared.isSignedIn)
        if active {
            hasAppleBrain = AppleClient.isAvailable
            if AccountStore.shared.isSignedIn { Task { await AccountStore.shared.refresh() } }
            reloadQueue(sayExpired: true)
            restartPolling()
            Task { await HealthService.shared.sendIfDue() }
            Task {
                // Each time it opens while one is on (a Mac paired again starts knowing nothing).
                await PhoneSensors.shared.report(force: PhoneSensors.shared.contactsOn || PhoneSensors.shared.calendarOn)
                await PhoneSensors.shared.sendCalendarIfDue()
            }
            resumeWakeWord()
            takeListenRequest()
            if listenOnOpen {
                listenOnOpen = false
                startListening()
            }
        } else {
            stopPolling()
            speech.cancel()
            voice.stop()
            // "Hey Jarvis" carries on in the background only when the owner turned that on.
            if !UserDefaults.standard.bool(forKey: Self.wakeBackgroundKey) { wake.stop() }
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
        brain.tools.mac = pairing.api
        watch.push(pairing)
        Task { await MacRouter.shared.reload() }
        restartPolling()
        pushNudged = false
        // Approvals and heads-ups as notifications: ask now, the moment it makes sense.
        Task { await PushCoordinator.shared.enable() }
    }

    /// A URL the app was opened with: a pairing link from the Mac's QR code (asked about
    /// first), or a place in the app.
    func open(_ url: URL) {
        if url.scheme == Destination.scheme, url.host == "listen" {
            // "Hey Jarvis" from Siri or Vocal Shortcuts, the Action Button, a Control.
            if foreground { startListening() } else { listenOnOpen = true }
        } else if let link = PairingLink(url.absoluteString) {
            offeredLink = link
        } else if let code = LinkCode.fromQR(url.absoluteString) {
            // A Mac's link code, read by the Camera app: the account screen asks about it.
            pendingLinkCode = code
            showAccount = true
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
        brain.tools.mac = pairing.api
        remote = nil
        link = .connecting
        watch.push(pairing)
        Task { await MacRouter.shared.reload() }
        restartPolling()
    }

    /// The Mac's device id in the owner's Jarvis account (from its /api/state, or from
    /// linking it here), kept with the pairing for the relay.
    func learnMacDeviceID(_ id: String?) {
        guard var pairing, pairing.macDeviceID != id else { return }
        pairing.macDeviceID = id
        try? PairingStore.save(pairing)
        self.pairing = pairing
        Task { await MacRouter.shared.reload() }
    }

    func unpair() {
        forget(notice: nil)
    }

    func resendToWatch() {
        watch.push(pairing)
        show("Sent to your Apple Watch.", style: .success)
    }

    // MARK: - Talking

    /// Opened by "Hey Jarvis", the Action Button or a Control: listen as soon as the app is in front.
    @ObservationIgnored var listenOnOpen = false

    /// Listen now (from a shortcut, a control, or the wake word).
    func startListening() {
        guard speech.status == .idle else { return }
        talk()
    }

    /// "Talk to Jarvis" ran (Siri, a control, the Action Button): listen once the app is in front.
    func takeListenRequest() {
        guard ListenRequest.pending else { return }
        ListenRequest.pending = false
        if foreground { startListening() } else { listenOnOpen = true }
    }

    private func wakeHeard() {
        guard speech.status == .idle, !voice.isPlaying else { return }
        Haptics.attention()
        guard OwnerLock.allows else { return voice.speakLocally(OwnerLock.refusal) }
        talk()
    }

    /// Picks the wake word back up when nothing else is using the microphone (in voice mode:
    /// listens for the owner's next turn).
    func resumeWakeWord() {
        if voiceMode { return listenInVoiceMode() }
        guard UserDefaults.standard.bool(forKey: Self.wakeKey), speech.status == .idle, !voice.isPlaying else { return }
        wake.start()
    }

    func setWakeWord(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.wakeKey)
        if on {
            resumeWakeWord()
        } else {
            wake.stop()
        }
    }

    /// The reactor: start listening, or finish and send.
    func talk() {
        switch speech.status {
        case .idle:
            voice.stop()
            wake.stop()  // one listener at a time
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
            show("I didn’t catch that. Tap the orb and try again.")
            resumeWakeWord()
            return
        }
        Task { await send(text, spoken: true) }
    }

    func sendDraft() {
        let text = draft.trimmed
        let pictures = attachments
        let files = documents
        guard !text.isEmpty || !pictures.isEmpty || !files.isEmpty else { return }
        draft = ""
        attachments = []
        documents = []
        Task {
            if pictures.isEmpty && files.isEmpty {
                await send(text)
            } else {
                await send(text, pictures: pictures, documents: files)
            }
        }
    }

    /// Adds documents to the composer (up to `PickedDocument.limit`).
    func attach(documents picked: [PickedDocument]) {
        let room = PickedDocument.limit - documents.count
        guard room > 0 else { return show("Up to \(PickedDocument.limit) documents at a time.") }
        documents += picked.prefix(room)
        if picked.count > room { show("Up to \(PickedDocument.limit) documents at a time, so the first \(room) went in.") }
    }

    /// Adds pictures to the composer, up to `Attachment.limit`.
    func attach(_ images: [UIImage]) {
        let room = Attachment.limit - attachments.count
        guard room > 0 else {
            return show("Up to \(Attachment.limit) pictures at a time.")
        }
        let added = images.prefix(room).compactMap(Attachment.init(image:))
        attachments += added
        if added.isEmpty, !images.isEmpty {
            show("Couldn’t read that picture.", style: .problem)
        } else if images.count > room {
            show("Up to \(Attachment.limit) pictures at a time, so the first \(room) went in.")
        }
    }

    /// A question about pictures (photos, screenshots): Jarvis on the Mac looks at them
    /// (POST /api/photo), or Jarvis on the iPhone when it's the one answering. They can't wait
    /// in the outbox: when the Mac can't be reached they go back into the composer.
    func send(_ raw: String, pictures: [Attachment], documents files: [PickedDocument] = []) async {
        let question = raw.trimmed.isEmpty
            ? (pictures.isEmpty ? PickedDocument.fallback(count: files.count) : PhotoQuestion.fallback(count: pictures.count))
            : raw.trimmed
        voice.stop()
        speech.cancel()
        if answersOnPhone {
            await askPhone(about: question, raw: raw, pictures: pictures, files: files)
            guard brain.lastFailed, brainMode == .automatic, pairing != nil, !isOffline else { return }
            brain.dropFailedAsk()  // the services failed: the Mac looks at them instead
        }
        guard let api = pairing?.api else { return }
        let unreachable = "Your Mac can’t be reached, so they stay here. Send them when it’s back."
        if isOffline { return restore(raw, pictures, unreachable, files) }
        if !files.isEmpty {
            // Documents go to the Mac's Inbox with the question; its answer lands in the conversation.
            do {
                for (index, file) in files.enumerated() {
                    _ = try await api.share(ShareItem(kind: .file, name: file.name, data: file.data,
                                                      note: index == files.count - 1 && pictures.isEmpty ? question : nil))
                }
                show(files.count == 1 ? "Sent to your Mac. The answer will be in the conversation." : "Sent \(files.count) documents to your Mac.")
                expectActivity()
            } catch {
                return restore(raw, pictures, handle(error)?.message ?? unreachable, files)
            }
            guard !pictures.isEmpty else { return }
        }
        // Under the Mac's 16 MB for all of them together.
        let each = pictures.count > 1 ? 4 * 1024 * 1024 : PhotoPrep.maxBytes
        let jpegs = pictures.compactMap { PhotoPrep.jpeg(from: $0.image, maxBytes: each) }
        guard jpegs.count == pictures.count else {
            return restore(raw, pictures, "Couldn’t prepare those pictures.")
        }
        sentPictures[question] = pictures.map(\.thumbnail)
        let request = PendingRequest(question: question, history: remote?.history ?? [])
        pending = request
        restartPolling()
        do {
            let result = try await api.photo(jpegs: jpegs, question: question)
            guard pending?.id == request.id else { return }
            if result.done {
                pending?.phase = .answered(result.reply)
                announce(result.reply)
            } else {
                pending?.phase = .waiting
            }
        } catch JarvisError.unpaired {
            return lost()
        } catch JarvisError.timedOut {
            if pending?.id == request.id { pending?.phase = .waiting }
        } catch let error as JarvisError where error.neverDelivered {
            if pending?.id == request.id { pending = nil }
            sentPictures[question] = nil
            // The Mac can't be reached: Jarvis on the iPhone looks at them instead.
            if phoneCanAnswer { return await askPhone(about: question, raw: raw, pictures: pictures, files: []) }
            return restore(raw, pictures, unreachable)
        } catch is CancellationError {
            return
        } catch {
            if pending?.id == request.id {
                pending?.phase = .failed((error as? JarvisError)?.errorDescription ?? error.localizedDescription)
                Haptics.failure()
            }
        }
        await refresh()
        resumeWakeWord()
    }

    /// Jarvis on the iPhone looks at pictures (and reads documents) with a question.
    private func askPhone(about question: String, raw: String, pictures: [Attachment], files: [PickedDocument]) async {
        let jpegs = pictures.compactMap { PhotoPrep.jpeg(from: $0.image, longest: 1568, maxBytes: 4 * 1024 * 1024) }
        guard jpegs.count == pictures.count else {
            return restore(raw, pictures, "Couldn’t prepare those pictures.", files)
        }
        await askPhone(question, images: jpegs, pictures: pictures.map(\.thumbnail),
                       documents: files.compactMap(\.block), files: files.map(\.name))
    }

    /// What a long press on a line asked for.
    func act(_ action: LineAction, on line: TranscriptLine) {
        switch action {
        case .readAloud:
            voice.stop()
            if let api = pairing?.api, !isOffline { voice.speak(line.text, using: api) } else { voice.speakLocally(line.text) }
        case .regenerate:
            guard let work = brain.regenerate() else { return }
            Task { if let reply = await work.value { announce(reply) } }
        case .edit:
            if let text = brain.takeBackLast() { draft = text }
        case .good:
            Haptics.answered(negative: false)
            UserDefaults.standard.set(UserDefaults.standard.integer(forKey: "feedback.good") + 1, forKey: "feedback.good")
            show("Thanks. Noted.", style: .success)
        case .bad:
            break  // the screen asks what was wrong (feedback(_:retry:))
        case .upgrade:
            showAccount = true
        }
    }

    /// What was wrong with a reply: kept as a correction (never repeated), and tried again
    /// with it when asked.
    func feedback(_ what: String, retry: Bool) {
        let lesson = what.trimmed
        if !lesson.isEmpty, !brain.temporary { LocalMemory.shared.add(lesson, kind: .correction) }
        Haptics.answered(negative: true)
        if retry, let work = brain.regenerate() {
            Task { if let reply = await work.value { announce(reply) } }
        } else {
            show(lesson.isEmpty ? "Thanks. Noted." : "Got it. Jarvis won’t do that again.", style: .success)
        }
    }

    /// Puts pictures that didn't go back into the composer, with what was typed.
    private func restore(_ text: String, _ pictures: [Attachment], _ message: String, _ files: [PickedDocument] = []) {
        if draft.trimmed.isEmpty { draft = text }
        attachments = Array((pictures + attachments).prefix(Attachment.limit))
        documents = Array((files + documents).prefix(PickedDocument.limit))
        Haptics.failure()
        show(message, style: .problem)
    }

    /// `queuedAt`: when it was first asked, for a question that waited in the outbox.
    func send(_ raw: String, queuedAt: Date? = nil, spoken: Bool = false) async {
        let text = raw.trimmed
        guard !text.isEmpty else { return }
        if answersOnPhone && queuedAt == nil {
            await askPhone(text, spoken: spoken)
            // Automatic: when the key's services fail, the Mac answers instead (if it's there).
            guard brain.lastFailed, brainMode == .automatic, pairing != nil, !isOffline else { return }
            brain.dropFailedAsk()
        }
        guard let api = pairing?.api else { return }
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
            if pending?.id == request.id { pending = nil }
            // It never got to the Mac: Jarvis on the iPhone answers when it can (not one that
            // already waited in the outbox for the Mac); otherwise it waits for the Mac.
            if queuedAt == nil, phoneCanAnswer { return await askPhone(text, spoken: spoken) }
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
        resumeWakeWord()
    }

    /// Jarvis on the iPhone answers.
    func askPhone(
        _ text: String, images: [Data] = [], pictures: [Data] = [], documents: [JSONValue] = [], files: [String] = [],
        spoken: Bool = false
    ) async {
        voice.stop()
        speech.cancel()
        let streaming = voiceMode && speakReplies
        if streaming {
            // Voice mode: each sentence is said as soon as it's written, and the owner can cut in.
            brain.onLiveText = { [weak self] text in
                guard let self, self.voiceMode else { return }
                self.voice.stream(text, final: false)
                if self.bargeIn.isListening { self.bargeIn.update(reply: text) } else if self.voice.isPlaying { self.bargeIn.start(reply: text) }
            }
        }
        defer { brain.onLiveText = nil }
        guard let reply = await brain.ask(text, images: images, pictures: pictures, documents: documents, files: files,
                                          spoken: spoken, macName: pairing?.macLabel) else {
            if streaming { voice.stop(); bargeIn.stop() }
            resumeWakeWord()
            return
        }
        if streaming, voiceMode {
            Haptics.reply()
            voice.stream(reply, final: true)
            if !bargeIn.isListening, voice.isPlaying { bargeIn.start(reply: reply) }
            return
        }
        announce(reply)
    }

    /// A reply to a request from this phone is in.
    private func announce(_ reply: String) {
        Haptics.reply()
        let canSpeak = foreground || (wake.isListening || UserDefaults.standard.bool(forKey: Self.wakeBackgroundKey))
        guard speakReplies, canSpeak, !reply.trimmed.isEmpty else {
            resumeWakeWord()
            return
        }
        // Jarvis's own voice from the Mac when it's there; the iPhone's best voice otherwise.
        if let api = pairing?.api, !isOffline {
            voice.speak(reply, using: api)
        } else {
            voice.speakLocally(reply)
        }
        if voiceMode { bargeIn.start(reply: reply) }
    }

    // MARK: - Voice mode

    /// A spoken conversation, hands free, as the ChatGPT, Gemini and Claude apps have it:
    /// Jarvis listens, answers aloud (sentence by sentence as it's written, on the iPhone), and
    /// listens again; talking over a reply stops it. Two silences in a row end it.
    private(set) var voiceMode = false
    @ObservationIgnored let bargeIn = BargeIn()
    @ObservationIgnored private var quietTurns = 0

    func startVoiceMode() {
        guard !voiceMode else { return }
        guard OwnerLock.allows else { return voice.speakLocally(OwnerLock.refusal) }
        voiceMode = true
        voice.duplex = true
        quietTurns = 0
        wake.stop()
        bargeIn.onSpeech = { [weak self] in self?.cutIn() }
        Haptics.talkStart()
        listenInVoiceMode()
    }

    func endVoiceMode() {
        guard voiceMode else { return }
        voiceMode = false
        bargeIn.stop()
        speech.cancel()
        voice.stop()
        voice.duplex = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Haptics.talkStop()
        resumeWakeWord()
    }

    /// The orb in voice mode: cuts a reply short, or sends what's been said so far.
    func voiceModeTap() {
        if voice.isPlaying || brain.isWorking { cutIn() } else if speech.status == .listening { speech.finish() } else if speech.status == .idle { listenInVoiceMode() }
    }

    /// The owner talked over the reply (or tapped): it stops, and Jarvis listens.
    private func cutIn() {
        guard voiceMode else { return }
        bargeIn.stop()
        voice.stop()
        if brain.isWorking { brain.cancel() }
        Haptics.attention()
        listenInVoiceMode()
    }

    private func listenInVoiceMode() {
        guard voiceMode, speech.status == .idle else { return }
        bargeIn.stop()  // one listener on the microphone at a time
        Task {
            do {
                try await speech.start { [weak self] heard in self?.heardInVoiceMode(heard) }
            } catch let problem as SpeechController.Problem {
                endVoiceMode()
                show(problem.errorDescription ?? "Can’t listen right now.", style: .problem, opensSettings: problem.needsSettings)
            } catch {
                endVoiceMode()
                show("Couldn’t start listening: \(error.localizedDescription)", style: .problem)
            }
        }
    }

    private func heardInVoiceMode(_ text: String) {
        guard voiceMode else { return }
        guard !text.isEmpty else {
            quietTurns += 1
            if quietTurns >= 2 {
                endVoiceMode()
                show("Voice mode ended.")
            } else {
                listenInVoiceMode()
            }
            return
        }
        quietTurns = 0
        Task { await send(text, spoken: true) }
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
        if command == .stop {
            voice.stop()
            speech.cancel()
            brain.cancel()
        }
        if answersOnPhone, command == .briefing {
            return await askPhone(Self.phoneBriefing)
        }
        guard let api = pairing?.api else { return }
        Haptics.tap()
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
            openMac()
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
            let relayed = await MacRouter.shared.isRelaying
            guard ticket > applied, pairing?.token == api.token else { return }  // a newer answer won
            applied = ticket
            if link != .online { link = .online }
            macOpening = false
            if viaRelay != relayed { viaRelay = relayed }
            apply(state)
            if let pairing { SnapshotPublisher.shared.publish(state, macName: pairing.macLabel) }
            if foreground { Task { await LiveActivities.shared.sync(state, api: api, inForeground: true) } }
            if !state.phoneAsks.isEmpty { Task { await PhoneSensors.shared.answer(state.phoneAsks, using: api) } }
            if foreground, PhoneSensors.shared.calendarOn {
                Task { await PhoneSensors.shared.sendCalendarIfDue(using: api) }  // every 30 minutes while open
            }
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
            if foreground, (error as? JarvisError)?.neverDelivered ?? true { openMac() }
        }
    }

    /// JARVIS on the Mac isn't answering: maybe it was quit. Its wake listener opens it, and
    /// polling picks it up (what waits in the outbox then goes).
    func openMac(force: Bool = false) {
        guard let api = pairing?.api, force || Date().timeIntervalSince(wokeAt) > 60 else { return }
        wokeAt = Date()
        Task {
            guard await api.wake(), isOffline else { return }
            macOpening = true
            show("Opening JARVIS on your Mac…")
            expectActivity(for: 40)
            try? await Task.sleep(for: .seconds(40))
            macOpening = false
        }
    }

    private func apply(_ state: RemoteState) {
        if state.accountDeviceID != pairing?.macDeviceID { learnMacDeviceID(state.accountDeviceID) }
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
        PhoneSensors.shared.forget()
        queued = []
        pairing = nil
        viaRelay = false
        Task { await MacRouter.shared.reload() }
        brain.tools.mac = nil
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
