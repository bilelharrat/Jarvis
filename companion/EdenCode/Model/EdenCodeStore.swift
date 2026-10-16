import Foundation
import Observation
import UIKit

/// The app's state: the paired Macs and the one in use, what it says (sessions, the cards that
/// wait, the pin, options, usage, the to-do column), and where the app should go next (a
/// push, a handoff, a Live Activity tapped). One per app.
///
/// Navigation is the G design's (2026-10-16): no tab bar. One session fills the screen (or the
/// new-session screen when none is open); the drawer from the left lists every session; the
/// Inbox, the Queue and Settings open over it as sheets from the drawer.
@MainActor
@Observable
final class EdenCodeStore {
    /// What opens over the session from the drawer.
    enum Panel: String, Identifiable, Hashable {
        case inbox, queue, settings
        var id: String { rawValue }
    }

    /// What pushes onto the session: its changes (the receipt, keep/undo, comments).
    enum Route: Hashable {
        case changes(Int)
    }

    private(set) var macs: [Pairing] = []
    private(set) var current: Pairing?
    private(set) var backend: (any CodeBackend)?
    /// "Try a demo": DemoBackend's sample data stands in for a Mac (App Review, anyone without
    /// a Mac yet, the debug screenshots). While it's on, nothing reaches the network: no push
    /// registration, no Live Activities, no relay, no widget, and its Macs are never saved.
    private(set) var demo = false

    var home = PhoneHome()
    var options = PhoneOptions()
    var usage: PhoneUsage?
    var todos = PhoneTodos(cards: [])
    /// The Mac's last error, in words, for the banner; nil while things work.
    var problem: String?
    /// The page's switch is off on the Mac (403 off): what to tell the owner.
    var switchedOff = false
    var loaded = false

    /// The session on screen; nil shows the new-session screen (G3).
    var openSession: Int?
    var path: [Route] = []
    /// The sessions drawer (G2).
    var drawerOpen = false
    /// The Inbox, the Queue or Settings, over everything.
    var panel: Panel?
    /// A card with no session to show it in (a session's own cards show inside it, G4).
    var sheetCard: PhoneCard?
    /// True once the app has chosen what to show first (or the owner chose): the landing
    /// session is picked once, never over the owner's own choice.
    private(set) var landed = false
    var showPairing = false
    /// A pairing QR code opened from outside (the Camera app, edencode://pair?…), for the
    /// pairing screen to pair with; or why it couldn't be read.
    var pendingPair: PairPayload?
    var pendingPairProblem: String?
    var search = ""

    /// Settings, kept on this iPhone.
    var speakReplies: Bool {
        didSet { UserDefaults.standard.set(speakReplies, forKey: "edencode.speakReplies") }
    }
    var liveActivitiesOn: Bool {
        didSet { UserDefaults.standard.set(liveActivitiesOn, forKey: "edencode.liveActivities") }
    }

    private var polling: Task<Void, Never>?
    private let liveActivities = EdenLiveActivities()
    private var lastPinOpened: Double {
        get { UserDefaults.standard.double(forKey: "edencode.lastPin") }
        set { UserDefaults.standard.set(newValue, forKey: "edencode.lastPin") }
    }

    init() {
        speakReplies = UserDefaults.standard.object(forKey: "edencode.speakReplies") as? Bool ?? false
        liveActivitiesOn = UserDefaults.standard.object(forKey: "edencode.liveActivities") as? Bool ?? true
        #if DEBUG
        if EdenDebug.fixtures {
            startDemo()
            return
        }
        #endif
        macs = MacStore.load()
        select(MacStore.current(in: macs))
    }

    /// The connection's problem as the banner shows it (what happened, what to do, a button).
    var issue: EdenCodeProblem?

    // MARK: - Macs

    var paired: Bool { backend != nil }

    func select(_ pairing: Pairing?) {
        if demo {
            // The demo's Macs are only labels: switching between them never makes a connection.
            if let pairing, DemoBackend.macs.contains(where: { PairingStore.same($0, pairing) }) {
                current = pairing
                return
            }
            demo = false
            macs = MacStore.load()
        }
        current = pairing
        MacStore.currentID = pairing.map(MacStore.key)
        backend = pairing.map { LiveBackend(api: $0.api) }
        // The relay (askeden.com, when signed in to the Eden account on this iPhone) is for
        // the Mac in use.
        MacRouter.pairingSource = { [pairing] in pairing }
        Task { await MacRouter.shared.reload() }
        home = PhoneHome()
        options = PhoneOptions()
        usage = nil
        todos = PhoneTodos(cards: [])
        loaded = false
        problem = nil
        issue = nil
        switchedOff = false
        path = []
        openSession = nil
        landed = false
        if pairing != nil { Task { await refreshAll() } }
    }

    func added(_ pairing: Pairing) {
        if demo { endDemo() }
        macs = MacStore.adding(pairing, to: macs)
        MacStore.save(macs)
        select(pairing)
        // Notifications are asked for here, once a real Mac is paired and can send them
        // (never at first launch, and never for the demo).
        PushRegistrar.shared.requestPermissionIfNeeded()
        PushRegistrar.shared.registerAgain()
    }

    func remove(_ pairing: Pairing) {
        if demo { endDemo(); return }
        let api = pairing.api
        Task { try? await api.unregisterPush() }
        macs = MacStore.removing(pairing, from: macs)
        MacStore.save(macs)
        if current.map({ PairingStore.same($0, pairing) }) ?? false { select(macs.first) }
    }

    /// The push token for every paired Mac (each sends this app's pushes on its own).
    func registerPush(token: String) async {
        if demo { return }
        let bundle = Bundle.main.bundleIdentifier ?? "com.askeden.jarvis.edencode"
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        for mac in macs where mac.isPinned {
            try? await mac.api.registerPush(token: token, environment: environment, bundleID: bundle)
        }
    }

    // MARK: - Reading

    func refreshAll() async {
        await refreshHome()
        async let options = try? backend?.options()
        async let usage = try? backend?.usage()
        async let todos = try? backend?.todos()
        if let found = await options { self.options = found }
        if let found = await usage { self.usage = found }
        if let found = await todos { self.todos = found }
    }

    func refreshHome() async {
        guard let backend else { return }
        do {
            let found = try await backend.home()
            home = found
            loaded = true
            land()
            problem = nil
            issue = nil
            switchedOff = false
            openPinIfNew(found.pinned)
            if demo { return }
            await liveActivities.sync(found.sessions, enabled: liveActivitiesOn, api: current?.api)
            WidgetSnapshotStore.save(home: found, mac: current?.macLabel ?? "")
            let count = found.needsYouCount
            try? await UNBadge.set(count)
        } catch {
            loaded = true
            note(error)
        }
    }

    func refreshTodos() async {
        if let found = try? await backend?.todos() { todos = found }
    }

    func refreshUsage() async {
        if let found = try? await backend?.usage() { usage = found }
    }

    /// Every 5 s while the app is in front (docs/eden-code-phone.md), and at once on a push.
    func startPolling() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshHome()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func stopPolling() {
        polling?.cancel()
        polling = nil
    }

    func note(_ error: Error) {
        guard let found = EdenCodeProblem(error, online: NetworkWatch.shared.online) else { return }
        switchedOff = found.kind == .switchedOff
        issue = found
        problem = found.text
    }

    /// The banner's button: try again now, or pair again when the Mac forgot this iPhone.
    func recover() {
        switch issue?.action {
        case .pairAgain: showPairing = true
        default: Task { await refreshAll() }
        }
    }

    // MARK: - Where to go

    /// The handoff's pin, when it's newer than the last one opened: opens once, as the page does.
    private func openPinIfNew(_ pinned: PhoneHome.Pinned?) {
        guard let pinned, pinned.at > lastPinOpened else { return }
        lastPinOpened = pinned.at
        open(session: pinned.id)
    }

    /// The first screen: the session that needs the owner, else the newest; the new-session
    /// screen when there are none. Once only, and never over a session the owner opened.
    func land() {
        guard !landed else { return }
        landed = true
        if openSession == nil, let id = home.landingID { openSession = id }
    }

    func open(session id: Int) {
        landed = true
        openSession = id
        path = []
        drawerOpen = false
        panel = nil
    }

    func openChanges(_ id: Int) {
        open(session: id)
        path = [.changes(id)]
    }

    /// ✎: the new-session screen.
    func startNew() {
        landed = true
        openSession = nil
        path = []
        drawerOpen = false
        panel = nil
    }

    /// The Inbox, the Queue or Settings, from the drawer.
    func show(_ panel: Panel) {
        drawerOpen = false
        self.panel = panel
    }

    /// A card from the Inbox or a push: inside its session (G4), or on its own when it has none.
    func show(card: PhoneCard) {
        if let id = card.taskID {
            open(session: id)
        } else {
            panel = nil
            sheetCard = card
        }
    }

    /// A notification tapped: a handoff or a finished/failed session opens its session; a card
    /// opens its sheet once the home view has it.
    func open(push userInfo: [AnyHashable: Any]) {
        guard let push = JarvisPush(userInfo: userInfo) else { return }
        let jarvis = userInfo["jarvis"] as? [String: Any] ?? [:]
        let handoff = jarvis["handoff"] as? Bool ?? false
        Task {
            await refreshHome()
            switch push.kind {
            case .codeApproval, .codeNeedsYou:
                if let card = home.attention.first(where: { $0.id == push.id || $0.taskID == push.taskID }) {
                    show(card: card)
                } else if let id = push.taskID {
                    open(session: id)
                }
            default:
                if let id = push.taskID { open(session: id) }
                if handoff, let pinned = home.pinned { lastPinOpened = max(lastPinOpened, pinned.at) }
            }
        }
    }

    /// The Mac's pairing QR code, scanned with the Camera app: the pairing screen (the first
    /// screen when no Mac is paired yet, else its sheet) pairs with it.
    func openPairing(_ url: URL) {
        switch PairPayload.parse(url) {
        case .success(let payload):
            pendingPair = payload
            pendingPairProblem = nil
        case .failure(let problem):
            pendingPair = nil
            pendingPairProblem = PairPayload.message(problem)
        }
        if paired { showPairing = true }
    }

    /// edencode://session/5, edencode://changes/5, edencode://inbox, edencode://queue,
    /// edencode://settings, edencode://new, edencode://pair?… (openPairing); anything else
    /// opens the drawer.
    func open(url: URL) {
        guard url.scheme?.lowercased() == "edencode" else {
            if let destination = Destination(url: url), case .codeSession(let id) = destination { open(session: id) }
            return
        }
        let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
        switch parts.first {
        case "pair": openPairing(url)
        case "session": if let id = parts.dropFirst().first.flatMap({ Int($0) }) { open(session: id) }
        case "changes": if let id = parts.dropFirst().first.flatMap({ Int($0) }) { openChanges(id) }
        case "inbox": show(.inbox)
        case "queue": show(.queue)
        case "settings": show(.settings)
        case "new": startNew()
        default: panel = nil; path = []; drawerOpen = true
        }
    }

    // MARK: - Doing

    /// Answers a card (Face ID first for a risky yes, as the Mac asks Touch ID). False when
    /// the owner didn't confirm or the Mac didn't take it.
    @discardableResult
    func answer(_ card: PhoneCard, _ choice: ApprovalChoice, feedback: String? = nil) async -> Bool {
        if card.macOnly && !choice.isNegative { return false }
        if card.needsFaceID(choice) {
            guard await OwnerCheck.confirm("Allow this on your Mac") else { return false }
        }
        do {
            let ok = try await backend?.answer(card: card.id, choice: choice.id, feedback: feedback)
            await refreshHome()
            return ok?.ok ?? false
        } catch {
            note(error)
            return false
        }
    }

    func startTodo(_ card: PhoneTodoCard) async -> String? {
        do {
            let ok = try await backend?.startTodo(card: card.id)
            await refreshTodos()
            if let id = ok?.id { open(session: id) }
            return nil
        } catch {
            return EdenCodeProblem.describe(error)
        }
    }

    // MARK: - The demo

    /// "Try a demo": sample sessions, cards and changes instead of a Mac. Nothing is saved and
    /// nothing is sent anywhere (DemoBackend); Exit demo or pairing a real Mac ends it.
    func startDemo() {
        let fixture = DemoBackend.shared
        fixture.reset()
        demo = true
        macs = DemoBackend.macs
        current = macs.first
        backend = fixture
        MacRouter.pairingSource = { nil }
        home = fixture.homeNow
        options = fixture.optionsNow
        usage = fixture.usageNow
        todos = fixture.todosNow
        problem = nil
        issue = nil
        switchedOff = false
        loaded = true
        path = []
        openSession = nil
        panel = nil
        drawerOpen = false
        landed = false
        land()
    }

    /// Back to the pairing screen (or the Macs this iPhone really is paired with).
    func endDemo() {
        demo = false
        panel = nil
        drawerOpen = false
        sheetCard = nil
        macs = MacStore.load()
        select(MacStore.current(in: macs))
    }
}

/// The app icon's badge: what waits on the owner.
enum UNBadge {
    @MainActor static func set(_ count: Int) async throws {
        try await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}

import UserNotifications
