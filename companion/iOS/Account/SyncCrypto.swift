import CryptoKit
import Foundation

/// Sealing for sync (docs/accounts.md): every item is sealed on the device with the sync
/// key, which askeden.com never has, and bound to its item key, so one item's sealed data
/// can't be passed off as another's.
enum SyncSeal {
    enum Failure: Error, Equatable {
        /// The data isn't base64, or too short to be sealed.
        case unreadable
        /// It didn't open with this key (or was sealed for another item key).
        case wrongKey
    }

    /// base64(nonce ‖ ciphertext ‖ tag), ChaCha20-Poly1305 with aad = the item key (UTF-8).
    static func seal(_ plaintext: Data, key: SymmetricKey, itemKey: String, nonce: ChaChaPoly.Nonce = ChaChaPoly.Nonce()) throws -> String {
        try ChaChaPoly.seal(plaintext, using: key, nonce: nonce, authenticating: Data(itemKey.utf8)).combined.base64EncodedString()
    }

    static func open(_ sealed: String, key: SymmetricKey, itemKey: String) throws -> Data {
        guard let combined = Data(base64Encoded: sealed), combined.count >= 12 + 16,
              let box = try? ChaChaPoly.SealedBox(combined: combined) else { throw Failure.unreadable }
        do {
            return try ChaChaPoly.open(box, using: key, authenticating: Data(itemKey.utf8))
        } catch {
            throw Failure.wrongKey
        }
    }
}

/// Handing a Mac the sync key while linking it: sealed to the Mac's own X25519 key, so only
/// that Mac can open it (askeden.com carries it without being able to).
///
///     shared = X25519(sender private, mac public)
///     key    = HKDF-SHA256(shared, salt: empty, info: "jarvis-link-v1", 32 bytes)
///     sealed = ChaCha20-Poly1305(key, 12 random bytes, sync key, aad: "jarvis-link-v1")
///     wire   = base64(nonce ‖ ciphertext ‖ tag)
enum LinkSeal {
    static let info = Data("jarvis-link-v1".utf8)

    enum Failure: Error, Equatable {
        case badPublicKey
        case unreadable
    }

    struct Sealed: Equatable, Sendable {
        /// base64 of the combined box.
        var sealedKey: String
        /// base64 of the sender's X25519 public key (32 bytes).
        var senderKey: String
    }

    /// A fresh sender key each time, unless a test gives one.
    static func seal(
        syncKey: Data, macPublicKey: String,
        sender: Curve25519.KeyAgreement.PrivateKey = .init(), nonce: ChaChaPoly.Nonce = ChaChaPoly.Nonce()
    ) throws -> Sealed {
        guard let raw = Data(base64Encoded: macPublicKey), raw.count == 32,
              let mac = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw) else { throw Failure.badPublicKey }
        let key = try derivedKey(sender.sharedSecretFromKeyAgreement(with: mac))
        let box = try ChaChaPoly.seal(syncKey, using: key, nonce: nonce, authenticating: info)
        return Sealed(sealedKey: box.combined.base64EncodedString(), senderKey: sender.publicKey.rawRepresentation.base64EncodedString())
    }

    /// What the Mac does with it (the app uses this only in tests).
    static func open(sealedKey: String, senderKey: String, macPrivate: Curve25519.KeyAgreement.PrivateKey) throws -> Data {
        guard let raw = Data(base64Encoded: senderKey), raw.count == 32,
              let sender = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw) else { throw Failure.badPublicKey }
        guard let combined = Data(base64Encoded: sealedKey), let box = try? ChaChaPoly.SealedBox(combined: combined) else {
            throw Failure.unreadable
        }
        let key = try derivedKey(macPrivate.sharedSecretFromKeyAgreement(with: sender))
        return try ChaChaPoly.open(box, using: key, authenticating: info)
    }

    static func open(sealed: Sealed, macPrivate: Curve25519.KeyAgreement.PrivateKey) throws -> Data {
        try open(sealedKey: sealed.sealedKey, senderKey: sealed.senderKey, macPrivate: macPrivate)
    }

    private static func derivedKey(_ shared: SharedSecret) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
    }
}

/// The sync key: 32 random bytes, made by the first iPhone that turns sync on, kept in the
/// Keychain as `sync-key.v1` and carried by iCloud Keychain to the owner's other iPhones.
enum SyncKeyStore {
    static let account = "sync-key.v1"

    static func load() -> SymmetricKey? {
        guard let data = Keychain.readSynced(account), data.count == 32 else { return nil }
        return SymmetricKey(data: data)
    }

    /// A new key, replacing any other.
    @discardableResult
    static func create() throws -> SymmetricKey {
        let key = SymmetricKey(size: .bits256)
        try Keychain.writeSynced(key.data, account: account)
        return key
    }

    static func clear() {
        Keychain.removeSynced(account)
    }
}

extension SymmetricKey {
    var data: Data { withUnsafeBytes { Data($0) } }
}
