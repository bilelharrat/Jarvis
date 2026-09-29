import Foundation
import Security

/// This device's pairing with Jarvis on a Mac. The token is a secret: it lives only in the
/// Keychain (and in memory), and is never logged or shown.
struct Pairing: Codable, Equatable, Sendable {
    var baseURL: URL
    var token: String
    var macName: String?
    var deviceName: String?
    var pairedAt: Date

    var api: JarvisAPI { JarvisAPI(baseURL: baseURL, token: token) }
    var address: String { MacAddress.display(baseURL) }
    /// What to call the Mac on screen.
    var macLabel: String { macName?.trimmed.isEmpty == false ? macName ?? address : address }
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
}

/// A thin wrapper over generic-password Keychain items, kept on this device only.
enum Keychain {
    struct Failure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Couldn’t save to the Keychain (error \(status))." }
    }

    private static let service = "com.bshventures.jarvis.companion"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func read(_ account: String) -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func write(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query(account)
            item.merge(attributes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    static func remove(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
