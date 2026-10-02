import CryptoKit
import Foundation

/// The owner's optional Jarvis account at askeden.com (docs/accounts.md): the plan, what's
/// been used this month, the devices on it, and how much is synced. Read forgivingly, like
/// the Mac's API: a field that goes missing never breaks the screen.
struct Account: Decodable, Equatable, Sendable {
    struct Plan: Decodable, Equatable, Sendable {
        /// "free" or "plus".
        var name = "free"
        var active = false
        var productID: String?
        var expires: Date?
        var renews: Bool?
        /// "Production", "Sandbox", or nil.
        var environment: String?

        var isPlus: Bool { name == "plus" && active }

        init() {}

        private enum Key: String, CodingKey {
            case name, active, expires, renews, environment
            case productID = "product_id"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            name = c.text(.name)?.lowercased() ?? "free"
            active = c.flag(.active) ?? false
            productID = c.text(.productID)
            expires = c.date(.expires)
            renews = c.flag(.renews)
            environment = c.text(.environment)
        }
    }

    struct Usage: Decodable, Equatable, Sendable {
        var periodStart: Date?
        var periodEnd: Date?
        var spentUSD: Double = 0
        var budgetUSD: Double = 0
        var leftUSD: Double = 0
        var trialLeftUSD: Double = 0
        /// Characters of JARVIS voice today, of the daily allowance.
        var voiceToday = 0
        var voiceDaily = 0

        init() {}

        private enum Key: String, CodingKey {
            case periodStart = "period_start", periodEnd = "period_end"
            case spentUSD = "spent_usd", budgetUSD = "budget_usd", leftUSD = "left_usd"
            case trialLeftUSD = "trial_left_usd"
            case voiceToday = "voice_today", voiceDaily = "voice_daily"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            periodStart = c.date(.periodStart)
            periodEnd = c.date(.periodEnd)
            spentUSD = max(0, c.number(.spentUSD) ?? 0)
            budgetUSD = max(0, c.number(.budgetUSD) ?? 0)
            leftUSD = max(0, c.number(.leftUSD) ?? max(0, budgetUSD - spentUSD))
            trialLeftUSD = max(0, c.number(.trialLeftUSD) ?? 0)
            voiceToday = max(0, c.integer(.voiceToday) ?? 0)
            voiceDaily = max(0, c.integer(.voiceDaily) ?? 0)
        }

        /// How much of the month's allowance is gone, 0…1.
        var spentFraction: Double { budgetUSD > 0 ? min(1, spentUSD / budgetUSD) : 0 }
        var voiceFraction: Double { voiceDaily > 0 ? min(1, Double(voiceToday) / Double(voiceDaily)) : 0 }
    }

    struct Device: Decodable, Equatable, Identifiable, Sendable {
        var id: String
        var name: String
        /// "iphone", "ipad", "watch" or "mac".
        var kind: String
        var created: Date?
        var lastSeen: Date?
        var appVersion: String?
        var push = false
        var relay = false
        /// The device asking.
        var isThis = false

        var isMac: Bool { kind == "mac" }

        /// The SF Symbol for it (a Mac is a laptop).
        var symbol: String {
            switch kind {
            case "mac": "laptopcomputer"
            case "ipad": "ipad"
            case "watch": "applewatch"
            default: "iphone"
            }
        }

        init(id: String, name: String, kind: String, isThis: Bool = false) {
            self.id = id
            self.name = name
            self.kind = kind
            self.isThis = isThis
        }

        private enum Key: String, CodingKey {
            case id, name, kind, created, push, relay
            case lastSeen = "last_seen", appVersion = "app_version", isThis = "this"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            id = c.text(.id) ?? ""
            kind = c.text(.kind)?.lowercased() ?? "iphone"
            name = c.text(.name)?.trimmed.nilIfEmpty ?? (kind == "mac" ? "Mac" : "iPhone")
            created = c.date(.created)
            lastSeen = c.date(.lastSeen)
            appVersion = c.text(.appVersion)
            push = c.flag(.push) ?? false
            relay = c.flag(.relay) ?? false
            isThis = c.flag(.isThis) ?? false
        }
    }

    struct SyncSummary: Decodable, Equatable, Sendable {
        var rev = 0
        var items = 0

        init() {}

        private enum Key: String, CodingKey { case rev, items }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            rev = max(0, c.integer(.rev) ?? 0)
            items = max(0, c.integer(.items) ?? 0)
        }
    }

    var id: String
    var created: Date?
    var plan = Plan()
    var usage = Usage()
    var devices: [Device] = []
    var sync = SyncSummary()

    init(id: String) {
        self.id = id
    }

    private enum Key: String, CodingKey { case id, created, plan, usage, devices, sync }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id)?.lowercased(), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: [Key.id], debugDescription: "No account id"))
        }
        self.id = id
        created = c.date(.created)
        plan = c.object(Plan.self, .plan) ?? Plan()
        usage = c.object(Usage.self, .usage) ?? Usage()
        devices = c.list(Device.self, .devices).filter { !$0.id.isEmpty }
        sync = c.object(SyncSummary.self, .sync) ?? SyncSummary()
    }

    var thisDevice: Device? { devices.first(where: \.isThis) }
    var macs: [Device] { devices.filter(\.isMac) }

    /// Included AI is available: Plus with allowance left, or trial money left.
    var hasAllowance: Bool { (plan.isPlus && usage.leftUSD > 0) || usage.trialLeftUSD > 0 }
}

/// This device's credential, as kept in the Keychain (`account.v1`):
/// `{"token","accountID","deviceID"}`. The token is a secret: never logged or shown.
struct AccountCredential: Codable, Equatable, Sendable {
    var token: String
    var accountID: String
    var deviceID: String

    /// A token's parts: `jv1.<account id>.<device id>.<secret>`; nil when it isn't one.
    static func parse(_ token: String) -> AccountCredential? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == "jv1",
              isAccountID(parts[1]), isDeviceID(parts[2]), isSecret(parts[3]) else { return nil }
        return AccountCredential(token: token, accountID: parts[1], deviceID: parts[2])
    }

    /// A lowercase UUID (8-4-4-4-12).
    static func isAccountID(_ text: String) -> Bool {
        guard text == text.lowercased(), text.count == 36, UUID(uuidString: text) != nil else { return false }
        return true
    }

    /// 16 lowercase hex characters.
    static func isDeviceID(_ text: String) -> Bool {
        text.count == 16 && text.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    /// 43 base64url characters (32 random bytes).
    static func isSecret(_ text: String) -> Bool {
        text.count == 43 && text.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// The account id Apple's user id leads to (the server makes it; the app can check it):
    /// the first 16 bytes of SHA-256("jarvis-account-v1:" + sub) as a UUID, version 8,
    /// RFC 4122 variant. It is also the StoreKit appAccountToken.
    static func accountID(appleUserID sub: String) -> String {
        var bytes = Array(SHA256.hash(data: Data("jarvis-account-v1:\(sub)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x80
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        let uuid = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                               bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
        return uuid.uuidString.lowercased()
    }
}

/// Where the credential lives: the Keychain, in the App Group's access group (so the share
/// extension and the intents have it), this device only. Readable from any thread.
enum AccountKeychain {
    static let account = "account.v1"

    static func load() -> AccountCredential? {
        guard let data = Keychain.read(account) else { return nil }
        return try? JSONDecoder().decode(AccountCredential.self, from: data)
    }

    static func save(_ credential: AccountCredential) throws {
        try Keychain.write(try JSONEncoder().encode(credential), account: account)
    }

    static func clear() {
        Keychain.remove(account)
    }

    /// The bearer token, when signed in.
    static var token: String? { load()?.token }
}

/// The code a Mac shows to join the account: 8 characters of Crockford base32 without I, L,
/// O or U, shown `XXXX-XXXX`; typed with or without the dash, in any case, or read from the
/// QR code `jarvis-link://XXXX-XXXX`.
enum LinkCode {
    static let scheme = "jarvis-link"
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// "K7QM-4ZTR", or nil when it can't be a link code.
    static func normalize(_ text: String) -> String? {
        var raw = text.trimmed
        if raw.lowercased().hasPrefix(scheme + "://") { raw = String(raw.dropFirst(scheme.count + 3)) }
        let code = raw.uppercased().filter { !"- ".contains($0) }
        guard code.count == 8, code.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return "\(code.prefix(4))-\(code.suffix(4))"
    }

    /// The code in a scanned QR code (only the link scheme).
    static func fromQR(_ text: String) -> String? {
        guard text.trimmed.lowercased().hasPrefix(scheme + "://") else { return nil }
        return normalize(text)
    }
}

/// Sign in with Apple's nonce: a random one goes with the request as its SHA-256 hex, and
/// the raw one to the server, which checks Apple's token carries the hash.
enum SignInNonce {
    static func make() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        return Data(bytes).base64URL
    }

    static func sha256Hex(_ raw: String) -> String {
        SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension Data {
    /// Base64url without padding.
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension Double {
    /// "$0.73", for the screen.
    var dollars: String { formatted(.currency(code: "USD").precision(.fractionLength(2))) }
}
