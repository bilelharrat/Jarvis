import Foundation

/// The Macs this iPhone's Eden Code is paired with, each with its own device token, and the
/// one in use. Eden Code pairs on its own (its own six-digit code, its own token), so the
/// Mac lists it as a device of its own and its pushes go to this app, never the companion's.
/// The list lives only in the Keychain, as the companion's pairing does (Shared/PairingStore:
/// the same Keychain wrapper, under Eden Code's own item, never the companion's "pairing.v1").
enum MacStore {
    static let account = "edencode.macs.v1"
    static let most = 8
    private static let currentKey = "edencode.currentMac"

    /// Every Mac paired, in the order they were paired (the first is the first one).
    static func load() -> [Pairing] {
        guard let data = Keychain.read(account) else { return [] }
        return (try? JSONDecoder().decode([Pairing].self, from: data)) ?? []
    }

    static func save(_ macs: [Pairing]) {
        if macs.isEmpty {
            Keychain.remove(account)
        } else if let data = try? JSONEncoder().encode(Array(macs.prefix(most))) {
            try? Keychain.write(data, account: account)
        }
    }

    /// A Mac paired again (the same certificate) replaces its old pairing; a new one is added.
    static func adding(_ pairing: Pairing, to macs: [Pairing]) -> [Pairing] {
        var list = macs
        if let index = list.firstIndex(where: { PairingStore.same($0, pairing) }) {
            list[index] = pairing
        } else {
            list.append(pairing)
        }
        return Array(list.suffix(most))
    }

    static func removing(_ pairing: Pairing, from macs: [Pairing]) -> [Pairing] {
        macs.filter { !PairingStore.same($0, pairing) }
    }

    /// The one in use: its fingerprint (else its address), kept in the app's defaults.
    static var currentID: String? {
        get { UserDefaults.standard.string(forKey: currentKey) }
        set { UserDefaults.standard.set(newValue, forKey: currentKey) }
    }

    static func key(_ pairing: Pairing) -> String {
        pairing.fingerprint.flatMap(CertificatePin.normalize) ?? pairing.baseURL.absoluteString
    }

    static func current(in macs: [Pairing]) -> Pairing? {
        macs.first { key($0) == currentID } ?? macs.first
    }

    /// Step one of pairing: the Mac's address and its certificate's fingerprint (trust on
    /// first use: nothing is sent), for the owner to compare with the Mac's Settings.
    static func probe(address: String) async throws -> (base: URL, fingerprint: String) {
        guard let base = MacAddress.normalize(address) else { throw JarvisError.invalidAddress }
        let fingerprint = try await JarvisAPI.probeFingerprint(at: base)
        return (base, CertificatePin.normalize(fingerprint) ?? fingerprint)
    }

    /// Step two: the six-digit code for this app's own token, over the pinned connection, and
    /// which account device the Mac is (what the relay connects to when away from home).
    static func pair(base: URL, fingerprint: String, code: String, deviceName: String) async throws -> Pairing {
        let api = JarvisAPI(baseURL: base, token: nil, fingerprint: fingerprint)
        let result = try await api.pair(code: code, deviceName: deviceName)
        var pairing = Pairing(baseURL: base, token: result.token, macName: result.macName, deviceName: deviceName,
                              pairedAt: Date(), fingerprint: fingerprint)
        if let state = try? await pairing.api.state() {
            pairing.macDeviceID = state.accountDeviceID
        }
        return pairing
    }
}
