import CryptoKit
import Foundation

/// Sync through the Jarvis account (docs/accounts.md › Sync): memory, the owner's settings
/// and this iPhone's chats, each sealed here with the sync key before it leaves, so
/// askeden.com keeps only what it can't read. Runs a few seconds after something changes,
/// when the app opens, and every five minutes while it's open.
@MainActor
@Observable
final class SyncEngine {
    static let shared = SyncEngine()

    enum Status: Equatable {
        case off
        case idle
        case syncing
        /// The account holds items sealed with a key this iPhone doesn't have (yet: iCloud
        /// Keychain may still bring it).
        case needsKey
        /// This iPhone's key doesn't open the account's items.
        case wrongKey
        case problem(String)
    }

    private(set) var status: Status = .off
    private(set) var lastSynced: Date?

    /// The account's API (nil when signed out).
    @ObservationIgnored var client: () -> AccountClient? = { AccountStore.shared.client }
    @ObservationIgnored var loadKey: () -> SymmetricKey? = { SyncKeyStore.load() }
    @ObservationIgnored var makeKey: () throws -> SymmetricKey = { try SyncKeyStore.create() }
    @ObservationIgnored private let memory: LocalMemory
    @ObservationIgnored private let chats: ChatStore
    @ObservationIgnored private let defaults: UserDefaults

    /// What this iPhone last saw of each item: its revision, and the hash of its plaintext
    /// as this iPhone writes it (nil: deleted). An item is sent when its hash changed.
    struct Known: Codable, Equatable {
        var rev: Int
        var hash: String?
    }

    private struct State: Codable, Equatable {
        var rev = 0
        var known: [String: Known] = [:]
    }

    @ObservationIgnored private var state = State()
    @ObservationIgnored private var running = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var applying = false

    static let enabledKey = "sync.enabled"
    private static let stateKey = "sync.state"
    private static let settingsKey = "sync.settings"
    /// Where the iPhone keeps what Jarvis calls the owner.
    static let addressKey = "brain.address"

    init(memory: LocalMemory? = nil, chats: ChatStore? = nil, defaults: UserDefaults = .standard) {
        self.memory = memory ?? .shared
        self.chats = chats ?? .shared
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.stateKey), let saved = try? JSONDecoder().decode(State.self, from: data) {
            state = saved
        }
    }

    /// The owner's choice (off until turned on in Settings › Account).
    var isOn: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        set {
            defaults.set(newValue, forKey: Self.enabledKey)
            if newValue { Task { await sync() } } else { status = .off }
        }
    }

    // MARK: - When

    /// Starts watching for changes (once), and syncs now.
    func start() {
        if observers.isEmpty {
            let center = NotificationCenter.default
            for name in [LocalMemory.changed, ChatStore.changed] {
                observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.changed() }
                })
            }
            observers.append(center.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.settingsMayHaveChanged() }
            })
        }
        settingsMayHaveChanged()  // what Jarvis calls the owner, set before sync was on
        Task { await sync() }
    }

    /// While the app is open: every five minutes.
    func setActive(_ active: Bool) {
        ticker?.cancel()
        ticker = nil
        guard active else { return }
        Task { await sync() }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled else { return }
                await self?.sync()
            }
        }
    }

    /// Something changed here: sync a few seconds from now.
    func changed() {
        guard !applying, isOn, client() != nil else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// Signed out: what this iPhone knew of the account goes (the key stays: it's the
    /// owner's, in iCloud Keychain).
    func signedOut() {
        debounce?.cancel()
        state = State()
        save()
        status = .off
        lastSynced = nil
    }

    // MARK: - Sync

    func sync() async {
        guard isOn, let client = client() else {
            if client() == nil { status = .off }
            return
        }
        if running {
            again = true
            return
        }
        running = true
        defer { running = false }
        repeat {
            again = false
            status = .syncing
            do {
                try await run(client)
                status = .idle
                lastSynced = Date()
            } catch let failure as Halt {
                status = failure.status
                return
            } catch is CancellationError {
                status = .idle
                return
            } catch {
                if case AccountError.signedOut = error {
                    AccountStore.shared.handle(error)
                    return
                }
                status = .problem(AccountStore.words(error))
                return
            }
        } while again
    }

    /// Everything goes (`DELETE /sync`), a new key is made, and this iPhone's items are sent
    /// again under it. For when the old key is lost.
    func startOver() async {
        guard let client = client() else { return }
        status = .syncing
        do {
            try await client.deleteAllSync()
            _ = try makeKey()
            state = State()
            save()
            status = .idle
            await sync()
        } catch {
            status = .problem(AccountStore.words(error))
        }
    }

    private struct Halt: Error {
        var status: Status
    }

    private func run(_ client: AccountClient) async throws {
        var key = loadKey()
        if key == nil {
            // The first iPhone to turn sync on makes the key; another waits for iCloud
            // Keychain to bring it rather than make a second one.
            let page = try await client.syncChanges(since: 0)
            guard page.items.allSatisfy(\.deleted) else { throw Halt(status: .needsKey) }
            key = try makeKey()
            state = State()
        }
        guard let key else { throw Halt(status: .needsKey) }

        try await pull(client, key: key)
        if state.known[SyncItems.keycheck] == nil {
            try await put(SyncItems.keycheck, plaintext: SyncItems.keycheckValue.encoded(), client: client, key: key)
        }
        try await push(client, key: key)
        save()
    }

    // MARK: - Pull

    private func pull(_ client: AccountClient, key: SymmetricKey) async throws {
        var since = state.rev
        while true {
            let page = try await client.syncChanges(since: since)
            // The key is checked before anything is applied: the wrong key changes nothing.
            if let check = page.items.first(where: { $0.key == SyncItems.keycheck }), let data = check.data {
                guard let plain = try? SyncSeal.open(data, key: key, itemKey: check.key), SyncItems.isKeycheck(plain) else {
                    throw Halt(status: .wrongKey)
                }
            }
            for item in page.items.sorted(by: { $0.rev < $1.rev }) {
                try apply(item, key: key)
            }
            let newest = page.items.map(\.rev).max() ?? since
            since = page.more ? max(since, newest) : max(page.rev, newest)
            state.rev = since
            save()
            guard page.more, !page.items.isEmpty else { return }
        }
    }

    /// Takes one item from the account into this iPhone.
    private func apply(_ item: AccountClient.SyncItem, key: SymmetricKey) throws {
        applying = true
        defer { applying = false }
        guard !item.deleted, let data = item.data else {
            if let id = SyncItems.chatID(fromKey: item.key) { chats.removeSynced(id) }
            state.known[item.key] = Known(rev: item.rev, hash: nil)
            return
        }
        let plain: Data
        do {
            plain = try SyncSeal.open(data, key: key, itemKey: item.key)
        } catch {
            throw Halt(status: .wrongKey)
        }
        let theirs = try canonical(item.key, plaintext: plain, merging: true)
        state.known[item.key] = Known(rev: item.rev, hash: theirs.map(Self.hash))
    }

    /// Merges their plaintext into this iPhone's data; returns theirs as this iPhone would
    /// write it (nil for an item it doesn't keep).
    private func canonical(_ key: String, plaintext: Data, merging: Bool) throws -> Data? {
        switch key {
        case SyncItems.keycheck:
            return try SyncItems.keycheckValue.encoded()
        case SyncItems.memory:
            guard let theirs = try? JSONDecoder().decode(SyncItems.Memory.self, from: plaintext) else { return nil }
            if merging { memory.applySynced(SyncItems.merge(memory.wireFacts, theirs.facts)) }
            return try Self.memoryPlaintext(theirs.facts)
        case SyncItems.settings:
            guard let theirs = SyncItems.Settings(json: plaintext) else { return nil }
            let mine = localSettings
            if merging, theirs.updated > mine.updated {
                saveSettings(theirs)
                defaults.set(theirs.addressAs ?? "", forKey: Self.addressKey)
                seenAddress = theirs.addressAs ?? ""
            }
            return try theirs.encoded()
        default:
            guard let id = SyncItems.chatID(fromKey: key),
                  let theirs = try? JSONDecoder().decode(SyncItems.Chat.self, from: plaintext) else { return nil }
            let mine = chats.chat(id)
            if merging, mine.map({ SyncItems.ms($0.updated) <= theirs.updated }) ?? true,
               let saved = SyncItems.savedChat(from: theirs, existing: mine) {
                chats.applySynced(saved)
            }
            return try SyncItems.encode(theirs)
        }
    }

    // MARK: - Push

    /// This iPhone's items as it would write them now.
    private func localItems() throws -> [(key: String, plaintext: Data)] {
        var items: [(String, Data)] = [(SyncItems.memory, try Self.memoryPlaintext(memory.wireFacts))]
        let settings = localSettings
        if settings.updated > 0 { items.append((SyncItems.settings, try settings.encoded())) }
        for chat in chats.chats {
            items.append((SyncItems.chatKey(chat.id), try SyncItems.encode(SyncItems.chat(from: chat))))
        }
        return items
    }

    private func push(_ client: AccountClient, key: SymmetricKey) async throws {
        let items = try localItems()
        for item in items where state.known[item.key]?.hash != Self.hash(item.plaintext) {
            try await put(item.key, plaintext: item.plaintext, client: client, key: key)
        }
        // Chats deleted here are deleted everywhere (a tombstone).
        let here = Set(items.map(\.key))
        for (itemKey, known) in state.known where itemKey.hasPrefix(SyncItems.chatPrefix) && known.hash != nil && !here.contains(itemKey) {
            let rev = try await client.deleteSyncItem(key: itemKey, baseRev: known.rev)
            state.known[itemKey] = Known(rev: max(rev, known.rev), hash: nil)
        }
    }

    /// Sends one item; on a conflict, merges theirs and tries again.
    private func put(_ itemKey: String, plaintext: Data, client: AccountClient, key: SymmetricKey) async throws {
        guard SyncItems.isValidKey(itemKey) else { return }
        var plaintext = plaintext
        var base = state.known[itemKey]?.rev ?? 0
        for _ in 0..<4 {
            let sealed = try SyncSeal.seal(plaintext, key: key, itemKey: itemKey)
            let result: AccountClient.PutResult
            do {
                result = try await client.putSyncItem(key: itemKey, data: sealed, baseRev: base)
            } catch AccountError.tooBig {
                state.known[itemKey] = Known(rev: base, hash: Self.hash(plaintext))  // not tried again until it changes
                return
            }
            switch result {
            case .saved(let rev):
                state.known[itemKey] = Known(rev: rev, hash: Self.hash(plaintext))
                save()
                return
            case .conflict(let theirs):
                try apply(theirs, key: key)
                base = theirs.rev
                guard let now = try localItems().first(where: { $0.key == itemKey })?.plaintext ?? (itemKey == SyncItems.keycheck ? plaintext : nil) else { return }
                if state.known[itemKey]?.hash == Self.hash(now) { return }  // theirs won: nothing to send
                plaintext = now
            }
        }
    }

    // MARK: - Settings

    /// The settings item as this iPhone knows it (fields it doesn't use included).
    var localSettings: SyncItems.Settings {
        guard let data = defaults.data(forKey: Self.settingsKey), let settings = SyncItems.Settings(json: data) else {
            return SyncItems.Settings()
        }
        return settings
    }

    private func saveSettings(_ settings: SyncItems.Settings) {
        if let data = try? settings.encoded() { defaults.set(data, forKey: Self.settingsKey) }
    }

    @ObservationIgnored private var seenAddress: String?

    /// What Jarvis calls the owner changed here: a newer settings item.
    private func settingsMayHaveChanged() {
        guard !applying else { return }
        let address = defaults.string(forKey: Self.addressKey)?.trimmed ?? ""
        if seenAddress == nil { seenAddress = localSettings.addressAs ?? "" }
        guard address != seenAddress else { return }
        seenAddress = address
        var settings = localSettings
        settings.addressAs = address.isEmpty ? nil : address
        settings.fields["updated"] = .int(Int(SyncItems.ms(Date())))
        saveSettings(settings)
        changed()
    }

    // MARK: - Plumbing

    /// Memory as written: facts in id order, so the same facts are always the same bytes.
    static func memoryPlaintext(_ facts: [SyncItems.WireFact]) throws -> Data {
        try SyncItems.encode(SyncItems.Memory(facts: facts.sorted { $0.id < $1.id }))
    }

    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(state) { defaults.set(data, forKey: Self.stateKey) }
    }
}
