import Foundation
import Observation
import UIKit

/// The app's state: the paired Macs and the one in use, what it says (sessions, the cards that
/// wait, the pin, options, usage, the to-do column), and where the app should go next (a
/// push, a handoff, a Live Activity tapped). One per app.
@MainActor
@Observable
final class EdenCodeStore {
    enum Tab: Hashable { case sessions, inbox, queue, settings }

    /// Where to go: a session, its changes, or a card to answer.
    enum Route: Hashable {
        case session(Int)
        case changes(Int)
    }

    private(set) var macs: [Pairing] = []
    private(set) var current: Pairing?
    private(set) var backend: (any CodeBackend)?
    /// The debug fixtures stand in for a Mac (screenshots, the Simulator without a Mac).
    private(set) var usingFixtures = false

    var home = PhoneHome()
    var options = PhoneOptions()
    var usage: PhoneUsage?
    var todos = PhoneTodos(cards: [])
    /// The Mac's last error, in words, for the banner; nil while things work.
    var problem: String?
    /// The page's switch is off on the Mac (403 off): what to tell the owner.
    var switchedOff = false
    var loaded = false

    var tab: Tab = .sessions
    var path: [Route] = []
    /// A card to show as the approval sheet.
    var sheetCard: PhoneCard?
    var showNewSession = false
    var showPairing = false
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
            useFixtures()
            return
        }
        #endif
        macs = MacStore.load()
        select(MacStore.current(in: macs))
    }

    // MARK: - Macs

    var paired: Bool { backend != nil }

    func select(_ pairing: Pairing?) {
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
        path = []
        if pairing != nil { Task { await refreshAll() } }
    }

    func added(_ pairing: Pairing) {
        macs = MacStore.adding(pairing, to: macs)
        MacStore.save(macs)
        select(pairing)
        PushRegistrar.shared.registerAgain()
    }

    func remove(_ pairing: Pairing) {
        let api = pairing.api
        Task { try? await api.unregisterPush() }
        macs = MacStore.removing(pairing, from: macs)
        MacStore.save(macs)
        if current.map({ PairingStore.same($0, pairing) }) ?? false { select(macs.first) }
    }

    /// The push token for every paired Mac (each sends this app's pushes on its own).
    func registerPush(token: String) async {
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
            problem = nil
            switchedOff = false
            openPinIfNew(found.pinned)
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
        if let jarvis = error as? JarvisError {
            if case .rejected(let message) = jarvis, message.contains("Hand off to phone") {
                switchedOff = true
                problem = "Turn on Eden Code on your phone on the Mac: Eden Code › More › Hand off to phone."
                return
            }
            problem = jarvis.errorDescription
        } else if !(error is CancellationError) {
            problem = error.localizedDescription
        }
    }

    // MARK: - Where to go

    /// The handoff's pin, when it's newer than the last one opened: opens once, as the page does.
    private func openPinIfNew(_ pinned: PhoneHome.Pinned?) {
        guard let pinned, pinned.at > lastPinOpened else { return }
        lastPinOpened = pinned.at
        open(session: pinned.id)
    }

    func open(session id: Int) {
        tab = .sessions
        path = [.session(id)]
    }

    func openChanges(_ id: Int) {
        tab = .sessions
        path = [.session(id), .changes(id)]
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
                    sheetCard = card
                } else if let id = push.taskID {
                    open(session: id)
                }
            default:
                if let id = push.taskID { open(session: id) }
                if handoff, let pinned = home.pinned { lastPinOpened = max(lastPinOpened, pinned.at) }
            }
        }
    }

    /// edencode://session/5, edencode://changes/5, edencode://inbox, edencode://new
    func open(url: URL) {
        guard url.scheme?.lowercased() == "edencode" else {
            if let destination = Destination(url: url), case .codeSession(let id) = destination { open(session: id) }
            return
        }
        let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
        switch parts.first {
        case "session": if let id = parts.dropFirst().first.flatMap({ Int($0) }) { open(session: id) }
        case "changes": if let id = parts.dropFirst().first.flatMap({ Int($0) }) { openChanges(id) }
        case "inbox": tab = .inbox
        case "queue": tab = .queue
        case "new": showNewSession = true
        default: tab = .sessions
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
            return (error as? JarvisError)?.message ?? error.localizedDescription
        }
    }

    // MARK: - Fixtures

    #if DEBUG
    func useFixtures() {
        usingFixtures = true
        let fixture = FixtureBackend.shared
        macs = FixtureBackend.macs
        current = macs.first
        backend = fixture
        home = fixture.homeNow
        options = fixture.optionsNow
        usage = fixture.usageNow
        todos = fixture.todosNow
        loaded = true
    }
    #endif
}

/// The app icon's badge: what waits on the owner.
enum UNBadge {
    @MainActor static func set(_ count: Int) async throws {
        try await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}

import UserNotifications
