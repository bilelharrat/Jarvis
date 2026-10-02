import Foundation
import Security

/// This device's pairing with Jarvis on a Mac. The token is a secret: it lives only in the
/// Keychain (and in memory), and is never logged or shown. The fingerprint is the Mac's
/// certificate, pinned when pairing: nothing is sent to a server that presents another.
struct Pairing: Codable, Equatable, Sendable {
    var baseURL: URL
    var token: String
    var macName: String?
    var deviceName: String?
    var pairedAt: Date
    /// Lowercase hex SHA-256 of the Mac's certificate. Pairings from before the companion
    /// spoke TLS have none, and pair again.
    var fingerprint: String?
    /// The Mac's device id in the owner's Jarvis account, once it's linked (from the Mac's
    /// /api/state): which device the encrypted relay connects to. Missing in older pairings.
    var macDeviceID: String? = nil

    var api: JarvisAPI { JarvisAPI(baseURL: baseURL, token: token, fingerprint: fingerprint) }
    var address: String { MacAddress.display(baseURL) }
    /// What to call the Mac on screen.
    var macLabel: String { macName?.trimmed.isEmpty == false ? macName ?? address : address }
    /// Usable: an https address and a pinned certificate.
    var isPinned: Bool { baseURL.scheme == "https" && fingerprint.flatMap(CertificatePin.normalize) != nil }
    /// "a1b2 c3d4 e5f6 0718", to compare with the Mac's Settings.
    var shortFingerprint: String? { fingerprint.map(CertificatePin.short) }
}

enum PairingStore {
    private static let account = "pairing.v1"

    static func load() -> Pairing? {
        guard let data = Keychain.read(account) else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ pairing: Pairing) throws {
        try Keychain.write(try JSONEncoder().encode(pairing), account: account)
    }

    static func clear() {
        Keychain.remove(account)
    }

    /// Once: a pairing saved before the App Group existed moves into its keychain group, so
    /// the share extension can use it too.
    static func shareWithExtensions(_ pairing: Pairing) {
        let key = "pairing.sharedGroup"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        if (try? save(pairing)) != nil { UserDefaults.standard.set(true, forKey: key) }
    }
}

/// The App Group the iPhone app shares with its widgets and share extension (and the Watch
/// app with its complications): a container for the widget snapshot and the outbox, and a
/// keychain access group for the pairing.
enum AppGroup {
    static let identifier = "group.com.bshventures.jarvis.companion"

    /// The shared container; nil when the build has no App Group entitlement (unsigned
    /// Simulator builds), when callers fall back to the app's own Application Support.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    /// The shared container, or this process's Application Support.
    static var directory: URL {
        if let container { return container }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        return support
    }
}

/// A thin wrapper over generic-password Keychain items, kept on this device only. On the
/// iPhone they go in the App Group's access group, so the share extension can use the
/// pairing too.
enum Keychain {
    struct Failure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Couldn’t save to the Keychain (error \(status))." }
    }

    private static let service = "com.bshventures.jarvis.companion"

    private static var sharedGroup: String? {
        #if os(iOS)
        AppGroup.identifier
        #else
        nil
        #endif
    }

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// From whichever access group has it.
    static func read(_ account: String) -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    /// Replaces every copy (an older one may sit in the app's own group) with one in the
    /// shared group, or the app's own when there is no shared group.
    static func write(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        remove(account)
        if let group = sharedGroup {
            var item = query(account)
            item.merge(attributes) { _, new in new }
            item[kSecAttrAccessGroup as String] = group
            let status = SecItemAdd(item as CFDictionary, nil)
            if status == errSecSuccess { return }
            guard status == errSecMissingEntitlement else { throw Failure(status: status) }
        }
        var item = query(account)
        item.merge(attributes) { _, new in new }
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    static func remove(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    // MARK: - Carried by iCloud Keychain

    // The few items the owner's other devices should have too (the sync key): the same
    // items, but synchronizable, so iCloud Keychain carries them. Never used for tokens.

    private static func syncedQuery(_ account: String) -> [String: Any] {
        var query = query(account)
        query[kSecAttrSynchronizable as String] = kCFBooleanTrue
        return query
    }

    static func readSynced(_ account: String) -> Data? {
        var query = syncedQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func writeSynced(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Synchronizable items can't be this-device-only.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        removeSynced(account)
        if let group = sharedGroup {
            var item = syncedQuery(account)
            item.merge(attributes) { _, new in new }
            item[kSecAttrAccessGroup as String] = group
            let status = SecItemAdd(item as CFDictionary, nil)
            if status == errSecSuccess { return }
            guard status == errSecMissingEntitlement else { throw Failure(status: status) }
        }
        var item = syncedQuery(account)
        item.merge(attributes) { _, new in new }
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    static func removeSynced(_ account: String) {
        SecItemDelete(syncedQuery(account) as CFDictionary)
    }
}
