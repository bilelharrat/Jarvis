import CommonCrypto
import CryptoKit
import Foundation

// Eden sync (docs/accounts.md "Eden sync", "The J.A.R.V.I.S. apps"; ROADMAP H1): Eden at
// askeden.com keeps the owner's chat history sealed with Eden's own key (32 bytes, not the
// apps' sync key). A new browser gets it only sealed to its own key pair, from a device that
// already has it, after both screens show the same six digits. This iPhone can be that device:
// it joins once as a member with its own X25519 key (Keychain, this device only), getting
// Eden's key from a browser that syncs or the recovery passphrase, then approves browsers.
// It never reads Eden's conversations; it holds the key only to hand it on.

/// Eden's crypto, exactly as the browser's eden-crypto.js (the shared vector is
/// Tests/Fixtures/eden-sync-vector.json, made with eden-crypto.js itself):
///
///     sealed = nonce(12) ‖ AES-256-GCM(HKDF-SHA256(ECDH(sender, device), salt: empty,
///              info: "eden-seal-v1"), aad: "eden-seal-v1", key); sender: a fresh key pair
///     proof  = base64url(HKDF-SHA256(key, salt: empty, info: "eden-sync-v1-proof", 32 bytes))
///     code   = six digits of SHA-256("eden-trust-v1:" + device public key, base64)
///     wrap   = nonce(12) ‖ AES-256-GCM(PBKDF2-SHA256(NFKC passphrase, salt, rounds), aad: "eden-wrap-v1", key)
///     mac    = base64url(HKDF-SHA256(key, salt: empty, info: "eden-member-v1:<alg>:<public key>", 32 bytes))
///     link   = nonce(12) ‖ AES-256-GCM(HKDF-SHA256(new key, salt: empty, info: "eden-chain-v1"),
///              aad: "eden-chain-v1:<gen>:<new epoch>", old key)
///
/// A browser's key is X25519, or P-256 (raw, uncompressed) where the browser lacks X25519.
///
/// Removing a device in a browser changes Eden's key (a new epoch): the browser seals the new
/// key to each member it can vouch for (this iPhone sends its `mac` when it proves) and keeps
/// the old key under the new one (the chain). This iPhone takes a new key only if the chain from
/// it leads back to the key it has, so askeden.com can't hand it a key of its own.
enum EdenCrypto {
    static let sealLabel = "eden-seal-v1"
    static let syncLabel = "eden-sync-v1"
    static let wrapLabel = "eden-wrap-v1"
    static let memberLabel = "eden-member-v1"
    static let chainLabel = "eden-chain-v1"

    enum Failure: Error, Equatable {
        case notADeviceKey
        case unreadable
        /// It didn't open with this key (or another label's).
        case wrongKey
        case wrongPassphrase
        case unknownWrap
    }

    struct Sealed: Equatable, Sendable {
        var sealedKey: String
        var senderKey: String
        var alg: String
    }

    /// The six digits both screens show for a device's key: "123 456".
    static func verifyCode(_ publicKey: String) -> String {
        let hash = Array(SHA256.hash(data: Data("eden-trust-v1:\(publicKey)".utf8)))
        let number = (UInt32(hash[0]) << 24 | UInt32(hash[1]) << 16 | UInt32(hash[2]) << 8 | UInt32(hash[3])) % 1_000_000
        let text = String(format: "%06u", number)
        return "\(text.prefix(3)) \(text.suffix(3))"
    }

    /// What askeden.com keeps a hash of: only a holder of the key can make it.
    static func proof(of secret: Data, label: String = syncLabel) -> String {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret), salt: Data(), info: Data("\(label)-proof".utf8), outputByteCount: 32
        )
        return key.data.base64URL
    }

    /// A member's public key vouched for with the key: a key change seals the new key only to
    /// members with one.
    static func memberMac(_ secret: Data, alg: String, publicKey: String) -> String {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret), salt: Data(), info: Data("\(memberLabel):\(alg):\(publicKey)".utf8), outputByteCount: 32
        )
        return key.data.base64URL
    }

    // MARK: A key change

    /// The key before `epoch`, kept under the key of `epoch` (one link of the chain).
    static func openChainLink(_ new: Data, link: String, gen: String, epoch: Int) throws -> Data {
        guard let combined = Data(edenBase64: link), combined.count == 12 + 32 + 16,
              let box = try? AES.GCM.SealedBox(combined: combined) else { throw Failure.unreadable }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: new), salt: Data(), info: Data(chainLabel.utf8), outputByteCount: 32)
        do {
            return try AES.GCM.open(box, using: key, authenticating: Data("\(chainLabel):\(gen):\(epoch)".utf8))
        } catch {
            throw Failure.wrongKey
        }
    }

    /// A new key (at `epoch`) checked: the chain from it must lead back to `mine` (at `from`),
    /// i.e. a holder of the key this iPhone has made it.
    static func followRekey(_ new: Data, epoch: Int, chain: [Int: String], gen: String, mine: Data, from: Int) throws {
        guard epoch > from else { throw Failure.wrongKey }
        var key = new
        for e in stride(from: epoch, to: from, by: -1) {
            guard let link = chain[e] else { throw Failure.unreadable }
            key = try openChainLink(key, link: link, gen: gen, epoch: e)
        }
        guard key == mine else { throw Failure.wrongKey }
    }

    // MARK: Sealing to a device

    /// `secret` sealed to a device's public key (base64 raw, X25519 or P-256), with a fresh
    /// sender key and nonce.
    static func seal(_ secret: Data, to publicKey: String, alg: String, label: String = sealLabel) throws -> Sealed {
        guard let raw = Data(edenBase64: publicKey) else { throw Failure.notADeviceKey }
        switch alg {
        case "x25519": return try sealX25519(secret, to: raw, label: label)
        case "p256": return try sealP256(secret, to: raw, label: label)
        default: throw Failure.notADeviceKey
        }
    }

    static func sealX25519(
        _ secret: Data, to raw: Data, label: String = sealLabel,
        sender: Curve25519.KeyAgreement.PrivateKey = .init(), nonce: AES.GCM.Nonce = .init()
    ) throws -> Sealed {
        guard raw.count == 32, let device = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw) else {
            throw Failure.notADeviceKey
        }
        let box = try box(secret, sender.sharedSecretFromKeyAgreement(with: device), label: label, nonce: nonce)
        return Sealed(sealedKey: box, senderKey: sender.publicKey.rawRepresentation.base64EncodedString(), alg: "x25519")
    }

    static func sealP256(
        _ secret: Data, to raw: Data, label: String = sealLabel,
        sender: P256.KeyAgreement.PrivateKey = .init(), nonce: AES.GCM.Nonce = .init()
    ) throws -> Sealed {
        guard raw.count == 65, raw.first == 4, let device = try? P256.KeyAgreement.PublicKey(x963Representation: raw) else {
            throw Failure.notADeviceKey
        }
        let box = try box(secret, sender.sharedSecretFromKeyAgreement(with: device), label: label, nonce: nonce)
        return Sealed(sealedKey: box, senderKey: sender.publicKey.x963Representation.base64EncodedString(), alg: "p256")
    }

    /// What a browser (or seal) sealed to this iPhone's X25519 key, opened.
    static func open(sealedKey: String, senderKey: String, with device: Curve25519.KeyAgreement.PrivateKey, label: String = sealLabel) throws -> Data {
        guard let raw = Data(edenBase64: senderKey), raw.count == 32,
              let sender = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw) else { throw Failure.notADeviceKey }
        return try unbox(sealedKey, try device.sharedSecretFromKeyAgreement(with: sender), label: label)
    }

    /// The same for a P-256 device key (the shared vector's other half; browsers without X25519).
    static func open(sealedKey: String, senderKey: String, with device: P256.KeyAgreement.PrivateKey, label: String = sealLabel) throws -> Data {
        guard let raw = Data(edenBase64: senderKey), raw.count == 65,
              let sender = try? P256.KeyAgreement.PublicKey(x963Representation: raw) else { throw Failure.notADeviceKey }
        return try unbox(sealedKey, try device.sharedSecretFromKeyAgreement(with: sender), label: label)
    }

    private static func key(_ shared: SharedSecret, label: String) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(label.utf8), outputByteCount: 32)
    }

    private static func box(_ secret: Data, _ shared: SharedSecret, label: String, nonce: AES.GCM.Nonce) throws -> String {
        let sealed = try AES.GCM.seal(secret, using: key(shared, label: label), nonce: nonce, authenticating: Data(label.utf8))
        guard let combined = sealed.combined else { throw Failure.unreadable }
        return combined.base64EncodedString()  // nonce ‖ ciphertext ‖ tag, as Web Crypto's
    }

    private static func unbox(_ sealedKey: String, _ shared: SharedSecret, label: String) throws -> Data {
        guard let combined = Data(edenBase64: sealedKey), combined.count >= 12 + 16,
              let box = try? AES.GCM.SealedBox(combined: combined) else { throw Failure.unreadable }
        do {
            return try AES.GCM.open(box, using: key(shared, label: label), authenticating: Data(label.utf8))
        } catch {
            throw Failure.wrongKey
        }
    }

    // MARK: The recovery passphrase

    /// What askeden.com keeps: `{ v: 1, kdf: "PBKDF2-SHA256", iterations, salt, data }`.
    struct Wrap: Equatable, Sendable {
        var iterations: Int
        var salt: String
        var data: String

        init(iterations: Int, salt: String, data: String) {
            self.iterations = iterations
            self.salt = salt
            self.data = data
        }

        init?(_ json: JSONValue?) {
            guard let json, json["v"]?.intValue == 1, json["kdf"]?.stringValue == "PBKDF2-SHA256",
                  let iterations = json["iterations"]?.intValue, let salt = json["salt"]?.stringValue,
                  let data = json["data"]?.stringValue else { return nil }
            self.init(iterations: iterations, salt: salt, data: data)
        }
    }

    /// Eden's key from the passphrase (NFKC, as the browser). Slow on purpose: hundreds of
    /// thousands of rounds; call it off the main actor.
    static func unwrap(passphrase: String, wrap: Wrap) throws -> Data {
        guard (100_000...10_000_000).contains(wrap.iterations), let salt = Data(edenBase64: wrap.salt),
              let combined = Data(edenBase64: wrap.data), combined.count >= 12 + 16,
              let box = try? AES.GCM.SealedBox(combined: combined) else { throw Failure.unknownWrap }
        let words = Data(passphrase.precomposedStringWithCompatibilityMapping.utf8)
        guard !words.isEmpty, let kek = pbkdf2(words, salt: salt, rounds: wrap.iterations) else { throw Failure.wrongPassphrase }
        do {
            return try AES.GCM.open(box, using: SymmetricKey(data: kek), authenticating: Data(wrapLabel.utf8))
        } catch {
            throw Failure.wrongPassphrase
        }
    }

    private static func pbkdf2(_ password: Data, salt: Data, rounds: Int) -> Data? {
        var out = Data(count: 32)
        let status = out.withUnsafeMutableBytes { derived in
            password.withUnsafeBytes { words in
                salt.withUnsafeBytes { salted in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        words.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                        salted.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds),
                        derived.baseAddress?.assumingMemoryBound(to: UInt8.self), 32
                    )
                }
            }
        }
        return status == kCCSuccess ? out : nil
    }
}

extension Data {
    /// Base64 as the browser writes or reads it: standard or URL-safe, padded or not.
    init?(edenBase64 text: String) {
        var clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        clean += String(repeating: "=", count: (4 - clean.count % 4) % 4)
        self.init(base64Encoded: clean)
    }
}

// MARK: - What's kept

/// This iPhone's Eden sync keys, in the Keychain (this device only, never iCloud):
/// `eden-device.v1` is its X25519 private key (raw), `eden-key.v1` Eden's key as
/// `{"account","gen","key","epoch"}`. Both go when the iPhone signs out of the account.
struct EdenKeyStore: Sendable {
    static let deviceAccount = "eden-device.v1"
    static let keyAccount = "eden-key.v1"

    struct Kept: Codable, Equatable, Sendable {
        var account: String
        var gen: String
        var key: Data
        /// Which of the account's keys (a new one each time a device is removed); nil: the first.
        var epoch: Int? = nil
    }

    var read: @Sendable (String) -> Data?
    var write: @Sendable (Data, String) throws -> Void
    var remove: @Sendable (String) -> Void

    static let keychain = EdenKeyStore(
        read: { Keychain.read($0) }, write: { try Keychain.write($0, account: $1) }, remove: { Keychain.remove($0) }
    )

    /// For tests: in memory.
    static func memory() -> EdenKeyStore {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var items: [String: Data] = [:]
        }
        let box = Box()
        return EdenKeyStore(
            read: { key in box.lock.withLock { box.items[key] } },
            write: { data, key in box.lock.withLock { box.items[key] = data } },
            remove: { key in _ = box.lock.withLock { box.items.removeValue(forKey: key) } }
        )
    }

    /// This iPhone's key pair for Eden sync, made once.
    func device() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = read(Self.deviceAccount), let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) {
            return key
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try write(key.rawRepresentation, Self.deviceAccount)
        return key
    }

    var kept: Kept? {
        read(Self.keyAccount).flatMap { try? JSONDecoder().decode(Kept.self, from: $0) }.flatMap { $0.key.count == 32 ? $0 : nil }
    }

    func keep(_ kept: Kept) throws {
        try write(try JSONEncoder().encode(kept), Self.keyAccount)
    }

    func dropKey() {
        remove(Self.keyAccount)
    }

    /// Signed out: nothing of Eden sync stays on this iPhone.
    func clear() {
        remove(Self.keyAccount)
        remove(Self.deviceAccount)
    }
}

// MARK: - askeden.com

/// GET /api/esync, read forgivingly.
struct EdenSyncStatus: Equatable, Sendable {
    struct Request: Equatable, Identifiable, Sendable {
        var deviceID: String
        var name: String
        var kind: String
        var publicKey: String
        var alg: String
        var expires: Date?

        var id: String { deviceID }
        /// The six digits the browser shows; approve only when they match.
        var code: String { EdenCrypto.verifyCode(publicKey) }

        var symbol: String {
            switch kind {
            case "mac": "laptopcomputer"
            case "iphone": "iphone"
            case "ipad": "ipad"
            default: "globe"
            }
        }
    }

    struct Member: Equatable, Sendable {
        var name: String
        var kind: String
        var isThis: Bool
    }

    /// A new key sealed to this iPhone after a device was removed.
    struct Rekey: Equatable, Sendable {
        var epoch: Int
        var sealedKey: String
        var senderKey: String
    }

    /// Eden sync is on for the account (some browser made the key).
    var hasKey = false
    var gen = ""
    /// Which of the account's keys is the one of now (a new one each time a device is removed).
    var epoch = 1
    /// A recovery passphrase is set.
    var wrap = false
    var trusted = false
    /// This iPhone vouched for its own public key (its `mac`); a key change seals only to such.
    var vouched = false
    var rekey: Rekey?
    /// The old keys kept under the new ones: epoch → link.
    var chain: [Int: String] = [:]
    var requests: [Request] = []
    var members: [Member] = []

    init() {}

    init(_ json: JSONValue) {
        if let key = json["key"], case .object = key {
            hasKey = true
            gen = key["gen"]?.stringValue ?? ""
            wrap = key["wrap"]?.boolValue ?? false
            epoch = max(1, key["epoch"]?.intValue ?? 1)
        }
        trusted = json["me"]?["trusted"]?.boolValue ?? false
        vouched = json["me"]?["mac"]?.boolValue ?? false
        if let r = json["me"]?["rekey"], let e = r["epoch"]?.intValue, let sealed = r["sealed_key"]?.stringValue,
           let sender = r["sender_key"]?.stringValue, (r["alg"]?.stringValue ?? "x25519") == "x25519" {
            rekey = Rekey(epoch: e, sealedKey: sealed, senderKey: sender)
        }
        for link in json["chain"]?.arrayValue ?? [] {
            if let e = link["epoch"]?.intValue, let prev = link["prev"]?.stringValue { chain[e] = prev }
        }
        requests = (json["requests"]?.arrayValue ?? []).compactMap { r in
            guard r["status"]?.stringValue ?? "waiting" == "waiting", let id = r["device_id"]?.stringValue,
                  let publicKey = r["public_key"]?.stringValue, let alg = r["alg"]?.stringValue else { return nil }
            return Request(
                deviceID: id, name: EdenSyncStatus.name(r["name"]?.stringValue), kind: r["kind"]?.stringValue ?? "web",
                publicKey: publicKey, alg: alg,
                expires: r["expires"]?.doubleValue.map { Date(timeIntervalSince1970: $0 / 1000) }
            )
        }
        members = (json["trusted"]?.arrayValue ?? []).map { t in
            Member(name: EdenSyncStatus.name(t["name"]?.stringValue), kind: t["kind"]?.stringValue ?? "", isThis: t["this"]?.boolValue ?? false)
        }
    }

    /// A browser's name as Eden gives it ("Eden on the web: Safari on a Mac") without the prefix.
    static func name(_ raw: String?) -> String {
        let name = (raw ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let short = name.hasPrefix("Eden on the web: ") ? String(name.dropFirst(17)) : name
        return short.isEmpty ? "A browser" : String(short.prefix(120))
    }
}

extension AccountClient {
    func edenSyncStatus() async throws -> EdenSyncStatus {
        EdenSyncStatus(try await decode(JSONValue.self, call("GET", "esync")))
    }

    /// POST /api/esync/<op> (docs/accounts.md, the table under "Eden sync").
    @discardableResult
    func edenSync(_ op: String, _ body: JSONValue = [:]) async throws -> JSONValue {
        try await decode(JSONValue.self, call("POST", "esync/\(op)", body: body))
    }
}

// MARK: - This iPhone as a member

/// Eden sync's key on this iPhone and what it does with it, for Settings › Account › Eden Sync.
@MainActor
@Observable
final class EdenTrust {
    static let shared = EdenTrust()

    enum State: Equatable {
        /// Not asked yet (or askeden.com couldn't be reached).
        case unknown
        /// No browser has turned Eden sync on.
        case off
        /// Eden sync is on; this iPhone hasn't the key.
        case locked
        /// Waiting for a browser that syncs to approve this iPhone: its six digits.
        case asking(code: String)
        /// This iPhone has the key and is trusted: it can approve browsers.
        case on
    }

    private(set) var status: EdenSyncStatus?
    private(set) var asking: String?
    private(set) var isWorking = false
    var problem: String?
    var done: String?

    @ObservationIgnored private let keys: EdenKeyStore
    @ObservationIgnored private let client: @MainActor () -> AccountClient?
    @ObservationIgnored private let accountID: @MainActor () -> String?
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored var pollInterval: Duration = .seconds(3)

    init(
        keys: EdenKeyStore = .keychain,
        client: @escaping @MainActor () -> AccountClient? = { AccountStore.shared.client },
        accountID: @escaping @MainActor () -> String? = { AccountStore.shared.credential?.accountID }
    ) {
        self.keys = keys
        self.client = client
        self.accountID = accountID
    }

    /// Eden's key, when it's this account's.
    private var kept: EdenKeyStore.Kept? {
        guard let kept = keys.kept, let account = accountID(), kept.account == account else { return nil }
        return kept
    }

    var hasKey: Bool { kept != nil }

    var state: State {
        guard let status else { return .unknown }
        if !status.hasKey { return .off }
        if status.trusted, hasKey { return .on }
        if let asking { return .asking(code: asking) }
        return .locked
    }

    // MARK: Asking askeden.com

    func refresh() async {
        guard let client = client() else { return }
        do {
            var fresh = try await client.edenSyncStatus()
            var note: String?
            if let kept = keys.kept, kept.account != accountID() || !fresh.hasKey || kept.gen != fresh.gen {
                keys.dropKey()  // another account's, or from before "Start over"
            } else if let kept, fresh.epoch > (kept.epoch ?? 1) {
                // A device was removed and Eden's key changed.
                note = try await keyChanged(kept, fresh, client: client)
                fresh = try await client.edenSyncStatus()
            } else if let kept, !fresh.trusted {
                // Signed in again (a new device id): it proves the key it has.
                do {
                    try await prove(kept.key, via: "approved", client: client)
                } catch AccountError.forbidden(let words) {
                    keys.dropKey()  // not the key of now: removed while signed out
                    note = words
                }
                fresh = try await client.edenSyncStatus()
            } else if let kept, !fresh.vouched {
                // Trusted before members vouched for themselves: now, so a key change includes it.
                _ = try? await prove(kept.key, via: "approved", client: client)
            }
            status = fresh
            problem = note
        } catch {
            handle(error)
        }
    }

    /// The new key sealed to this iPhone, taken only if the chain from it leads back to the key it
    /// has; left out (removed, or nobody vouched for it), the old key goes. What to say, if anything.
    private func keyChanged(_ kept: EdenKeyStore.Kept, _ fresh: EdenSyncStatus, client: AccountClient) async throws -> String? {
        guard fresh.trusted, let rekey = fresh.rekey, rekey.epoch == fresh.epoch else {
            keys.dropKey()
            return "Eden’s key changed when a device was removed from sync, and this iPhone was left out. Ask a browser that syncs to approve it again."
        }
        let new: Data
        do {
            new = try EdenCrypto.open(sealedKey: rekey.sealedKey, senderKey: rekey.senderKey, with: try keys.device())
            try EdenCrypto.followRekey(new, epoch: rekey.epoch, chain: fresh.chain, gen: kept.gen, mine: kept.key, from: kept.epoch ?? 1)
        } catch {
            return "askeden.com offered a new Eden key this iPhone couldn’t check, so it isn’t used. Stop holding the key here, then ask a browser that syncs again."
        }
        try await prove(new, via: "approved", client: client)
        try keys.keep(.init(account: kept.account, gen: kept.gen, key: new, epoch: rekey.epoch))
        return nil
    }

    /// Proves the key (vouching for this iPhone's public key with it); the key's epoch.
    @discardableResult
    private func prove(_ secret: Data, via: String, client: AccountClient) async throws -> Int {
        let device = try keys.device()
        let publicKey = device.publicKey.rawRepresentation.base64EncodedString()
        let got = try await client.edenSync("prove", [
            "proof": .string(EdenCrypto.proof(of: secret)),
            "public_key": .string(publicKey),
            "alg": "x25519",
            "via": .string(via),
            "mac": .string(EdenCrypto.memberMac(secret, alg: "x25519", publicKey: publicKey)),
        ])
        return max(1, got["epoch"]?.intValue ?? 1)
    }

    // MARK: Joining

    /// Asks a browser that syncs for Eden's key: shows this iPhone's six digits until a
    /// browser approves, says no, or 15 minutes pass.
    func ask() async {
        guard let client = client() else { return }
        problem = nil
        done = nil
        do {
            let publicKey = try keys.device().publicKey.rawRepresentation.base64EncodedString()
            try await client.edenSync("request", ["public_key": .string(publicKey), "alg": "x25519"])
            asking = EdenCrypto.verifyCode(publicKey)
            poller?.cancel()
            poller = Task { [weak self] in await self?.poll(client) }
        } catch {
            handle(error)
        }
    }

    func cancel() async {
        poller?.cancel()
        poller = nil
        asking = nil
        _ = try? await client()?.edenSync("deny")
    }

    private func poll(_ client: AccountClient) async {
        let until = Date().addingTimeInterval(15 * 60)
        while !Task.isCancelled, asking != nil, Date() < until {
            try? await Task.sleep(for: pollInterval)
            guard !Task.isCancelled else { return }
            let got: JSONValue
            do {
                got = try await client.edenSync("poll")
            } catch AccountError.expired {
                break
            } catch {
                continue  // offline for a moment: ask again
            }
            switch got["status"]?.stringValue {
            case "denied":
                asking = nil
                problem = "The browser said no."
                return
            case "approved":
                await joined(got, client: client)
                return
            default:
                continue
            }
        }
        if asking != nil, !Task.isCancelled {
            asking = nil
            problem = "That request ran out. Ask again."
        }
    }

    private func joined(_ got: JSONValue, client: AccountClient) async {
        do {
            guard got["alg"]?.stringValue == "x25519", let sealed = got["sealed_key"]?.stringValue,
                  let sender = got["sender_key"]?.stringValue else { throw EdenCrypto.Failure.unreadable }
            let secret = try EdenCrypto.open(sealedKey: sealed, senderKey: sender, with: try keys.device())
            guard secret.count == 32 else { throw EdenCrypto.Failure.unreadable }
            let epoch = try await prove(secret, via: "approved", client: client)
            let fresh = try await client.edenSyncStatus()
            try keep(secret, gen: fresh.gen, epoch: epoch)
            asking = nil
            status = fresh
            Haptics.answered(negative: false)
            done = "This iPhone has Eden’s key now."
        } catch let failure as EdenCrypto.Failure {
            asking = nil
            problem = "The key that came didn’t open with this iPhone’s (\(failure)). Ask again."
        } catch {
            asking = nil
            handle(error)
        }
    }

    private func keep(_ secret: Data, gen: String, epoch: Int) throws {
        guard let account = accountID() else { throw AccountError.signedOut }
        try keys.keep(.init(account: account, gen: gen, key: secret, epoch: epoch))
    }

    /// Eden's key from the recovery passphrase (askeden.com keeps it wrapped), then proved.
    func unlock(passphrase: String) async {
        guard let client = client(), !passphrase.isEmpty else { return }
        isWorking = true
        defer { isWorking = false }
        problem = nil
        done = nil
        do {
            let got = try await client.edenSync("unwrap")
            guard let wrap = EdenCrypto.Wrap(got["wrap"]) else { throw AccountError.malformed }
            let secret = try await Task.detached(priority: .userInitiated) {
                try EdenCrypto.unwrap(passphrase: passphrase, wrap: wrap)
            }.value
            let epoch = try await prove(secret, via: "passphrase", client: client)
            try keep(secret, gen: got["gen"]?.stringValue ?? "", epoch: epoch)
            await cancel()
            await refresh()
            Haptics.answered(negative: false)
            done = "This iPhone has Eden’s key now."
        } catch EdenCrypto.Failure.wrongPassphrase {
            Haptics.failure()
            problem = "That isn’t the recovery passphrase. Check it and try again."
        } catch {
            Haptics.failure()
            handle(error)
        }
    }

    /// Stops being a member: askeden.com untrusts this iPhone, and its copy of the key goes.
    func forget() async {
        _ = try? await client()?.edenSync("untrust")
        keys.dropKey()
        done = "This iPhone no longer has Eden’s key."
        await refresh()
    }

    // MARK: Approving a browser

    /// Seals Eden's key to the browser the owner checked (its six digits matched), after
    /// asking askeden.com again that it's still waiting with that same key.
    func approve(_ request: EdenSyncStatus.Request) async {
        guard let client = client() else { return }
        isWorking = true
        defer { isWorking = false }
        problem = nil
        await refresh()  // picks up a new key first, if a device was removed meanwhile
        do {
            guard let kept else { throw AccountError.forbidden("This iPhone doesn’t have Eden’s key yet.") }
            let fresh = try await client.edenSyncStatus()
            status = fresh
            guard let now = fresh.requests.first(where: { $0.deviceID == request.deviceID }) else {
                throw AccountError.notFound("That browser stopped waiting. Ask again from the browser.")
            }
            guard now.publicKey == request.publicKey else {
                throw AccountError.conflict("That browser’s key changed. Check its code again.")
            }
            let sealed = try EdenCrypto.seal(kept.key, to: now.publicKey, alg: now.alg)
            try await client.edenSync("approve", [
                "device_id": .string(now.deviceID),
                "public_key": .string(now.publicKey),
                "sealed_key": .string(sealed.sealedKey),
                "sender_key": .string(sealed.senderKey),
                // Vouches for the key whose code matched, for a later key change.
                "mac": .string(EdenCrypto.memberMac(kept.key, alg: now.alg, publicKey: now.publicKey)),
            ])
            Haptics.answered(negative: false)
            done = "Approved. \(now.name) syncs Eden now."
            await refresh()
        } catch {
            Haptics.failure()
            handle(error)
        }
    }

    func deny(_ request: EdenSyncStatus.Request) async {
        do {
            try await client()?.edenSync("deny", ["device_id": .string(request.deviceID)])
            done = "Turned down. \(request.name) doesn’t get Eden’s key."
            await refresh()
        } catch {
            handle(error)
        }
    }

    /// Signed out: nothing of Eden sync stays here.
    func signedOut() {
        poller?.cancel()
        poller = nil
        asking = nil
        status = nil
        done = nil
        problem = nil
        keys.clear()
    }

    private func handle(_ error: Error) {
        if case AccountError.signedOut = error {
            AccountStore.shared.handle(error)
            return
        }
        if case EdenCrypto.Failure.notADeviceKey = error {
            problem = "That browser’s key isn’t one Eden makes. Ask again from the browser."
            return
        }
        problem = AccountStore.words(error)
    }
}
