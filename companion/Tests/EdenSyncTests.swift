import CryptoKit
import XCTest

@testable import JarvisCompanion

/// Eden sync on the iPhone (EdenSync.swift; docs/accounts.md "Eden sync"): the crypto matches the
/// browser's byte for byte (Fixtures/eden-sync-vector.json, made by site/scripts/eden-sync-vector.mjs
/// with eden-crypto.js; the Mac's tests read the same file), and the iPhone joins and approves a
/// browser against a fake askeden.com that keeps eden-sync.js's rules (FakeEdenServer). With
/// EDEN_DEV_BASE, EDEN_DEV_TOKEN and EDEN_DEV_PASSPHRASE set (TEST_RUNNER_ prefixed for
/// xcodebuild), the same runs once against a local `wrangler dev` Worker.
@MainActor
final class EdenSyncTests: XCTestCase {
    private struct Vector {
        let json: JSONValue
        func text(_ path: String...) -> String {
            var at: JSONValue? = json
            for key in path { at = at?[key] }
            return at?.stringValue ?? ""
        }
        func data(_ path: String...) -> Data {
            var at: JSONValue? = json
            for key in path { at = at?[key] }
            return Data(base64Encoded: at?.stringValue ?? "") ?? Data()
        }
    }

    private func vector() throws -> Vector {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "eden-sync-vector", withExtension: "json"), "no Fixtures/eden-sync-vector.json")
        return Vector(json: try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)))
    }

    // MARK: - The shared vector

    func testWhatTheBrowserSealedOpensOnTheIPhone() throws {
        let v = try vector()
        let secret = v.data("secret")
        let x = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: v.data("x25519", "private"))
        XCTAssertEqual(x.publicKey.rawRepresentation.base64EncodedString(), v.text("x25519", "public"))
        XCTAssertEqual(try EdenCrypto.open(sealedKey: v.text("x25519", "browser_sealed", "sealed_key"), senderKey: v.text("x25519", "browser_sealed", "sender_key"), with: x), secret)
        let p = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.data("p256", "private"))
        XCTAssertEqual(p.publicKey.x963Representation.base64EncodedString(), v.text("p256", "public"))
        XCTAssertEqual(try EdenCrypto.open(sealedKey: v.text("p256", "browser_sealed", "sealed_key"), senderKey: v.text("p256", "browser_sealed", "sender_key"), with: p), secret)
        // Another label (a team space's key) doesn't open as Eden's key.
        XCTAssertThrowsError(try EdenCrypto.open(sealedKey: v.text("x25519", "browser_sealed", "sealed_key"), senderKey: v.text("x25519", "browser_sealed", "sender_key"), with: x, label: "eden-space-seal-v1")) { error in
            XCTAssertEqual(error as? EdenCrypto.Failure, .wrongKey)
        }
    }

    func testTheIPhoneSealsTheBrowsersBytesExactly() throws {
        let v = try vector()
        let secret = v.data("secret")
        let nonce = try AES.GCM.Nonce(data: v.data("x25519", "app_sealed", "nonce"))
        let x = try EdenCrypto.sealX25519(
            secret, to: v.data("x25519", "public"),
            sender: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: v.data("x25519", "app_sealed", "sender_private")), nonce: nonce
        )
        XCTAssertEqual(x, EdenCrypto.Sealed(sealedKey: v.text("x25519", "app_sealed", "sealed_key"), senderKey: v.text("x25519", "app_sealed", "sender_key"), alg: "x25519"))
        let p = try EdenCrypto.sealP256(
            secret, to: v.data("p256", "public"),
            sender: try P256.KeyAgreement.PrivateKey(rawRepresentation: v.data("p256", "app_sealed", "sender_private")), nonce: nonce
        )
        XCTAssertEqual(p, EdenCrypto.Sealed(sealedKey: v.text("p256", "app_sealed", "sealed_key"), senderKey: v.text("p256", "app_sealed", "sender_key"), alg: "p256"))
        // With a fresh sender and nonce, what it seals opens for the device and differs each time.
        let device = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.data("p256", "private"))
        let fresh = try EdenCrypto.seal(secret, to: v.text("p256", "public"), alg: "p256")
        XCTAssertEqual(try EdenCrypto.open(sealedKey: fresh.sealedKey, senderKey: fresh.senderKey, with: device), secret)
        XCTAssertNotEqual(fresh, try EdenCrypto.seal(secret, to: v.text("p256", "public"), alg: "p256"))
        XCTAssertThrowsError(try EdenCrypto.seal(secret, to: "c2hvcnQ=", alg: "x25519"))
        XCTAssertThrowsError(try EdenCrypto.seal(secret, to: v.text("x25519", "public"), alg: "p256"))
    }

    func testCodesProofAndPassphraseMatchTheBrowser() throws {
        let v = try vector()
        XCTAssertEqual(EdenCrypto.verifyCode(v.text("x25519", "public")), v.text("x25519", "code"))
        XCTAssertEqual(EdenCrypto.verifyCode(v.text("p256", "public")), v.text("p256", "code"))
        XCTAssertEqual(EdenCrypto.proof(of: v.data("secret")), v.text("proof"))
        let wrap = try XCTUnwrap(EdenCrypto.Wrap(v.json["passphrase"]?["wrap"]))
        // NFKC, as the browser: the vector's passphrase has a ligature it folds.
        XCTAssertEqual(try EdenCrypto.unwrap(passphrase: v.text("passphrase", "passphrase"), wrap: wrap), v.data("secret"))
        XCTAssertThrowsError(try EdenCrypto.unwrap(passphrase: v.text("passphrase", "passphrase") + "!", wrap: wrap)) { error in
            XCTAssertEqual(error as? EdenCrypto.Failure, .wrongPassphrase)
        }
        var weak = wrap
        weak.iterations = 1000
        XCTAssertThrowsError(try EdenCrypto.unwrap(passphrase: v.text("passphrase", "passphrase"), wrap: weak)) { error in
            XCTAssertEqual(error as? EdenCrypto.Failure, .unknownWrap)
        }
    }

    func testStatusIsReadForgivingly() {
        let status = EdenSyncStatus([
            "key": ["gen": "gen-1", "wrap": true],
            "me": ["trusted": true],
            "requests": [
                ["device_id": "beef0000beef0000", "name": "Eden on the web: Safari on an iPhone", "kind": "web", "public_key": "AAAA", "alg": "p256", "status": "waiting", "expires": 1_790_000_000_000],
                ["device_id": "nope"],
            ],
            "trusted": [["name": "Studio", "kind": "mac", "this": false]],
        ])
        XCTAssertTrue(status.hasKey && status.wrap && status.trusted)
        XCTAssertEqual(status.requests.map(\.name), ["Safari on an iPhone"])
        XCTAssertEqual(status.requests.first?.code, EdenCrypto.verifyCode("AAAA"))
        XCTAssertEqual(EdenSyncStatus(["key": .null]).hasKey, false)
    }

    // MARK: - Against a fake askeden.com

    nonisolated private static let account = "8d3c1a52-7e44-8a10-9f6e-2b1c0d4e5f60"
    nonisolated private static let token = "jv1.\(account).a1b2c3d4e5f60718." + String(repeating: "A", count: 43)

    private func member(keys: EdenKeyStore = .memory(), base: URL = URL(string: "https://eden.test/api")!, token: String = token, account: String = account) -> EdenTrust {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeEdenServer.self]
        let session = URLSession(configuration: config)
        let trust = EdenTrust(keys: keys, client: { AccountClient(base: base, token: token, session: session) }, accountID: { account })
        trust.pollInterval = .milliseconds(10)
        return trust
    }

    override func setUp() async throws {
        FakeEdenServer.reset()
    }

    func testThePassphraseUnlocksThenTheIPhoneApprovesTheBrowserItChecked() async throws {
        let v = try vector()
        FakeEdenServer.turnOn(secret: v.data("secret"), wrap: v.json["passphrase"]?["wrap"] ?? .null)
        FakeEdenServer.browserAsks(publicKey: v.text("p256", "public"), alg: "p256")
        let keys = EdenKeyStore.memory()
        let trust = member(keys: keys)
        await trust.refresh()
        XCTAssertEqual(trust.state, .locked)
        XCTAssertEqual(trust.status?.requests, [], "only a trusted device sees who's waiting")
        await trust.unlock(passphrase: "not it at all")
        XCTAssertEqual(trust.problem, "That isn’t the recovery passphrase. Check it and try again.")
        await trust.unlock(passphrase: v.text("passphrase", "passphrase"))
        XCTAssertEqual(trust.state, .on, trust.problem ?? "")
        XCTAssertEqual(keys.kept?.key, v.data("secret"))
        XCTAssertEqual(FakeEdenServer.trustedVia, "passphrase")
        let request = try XCTUnwrap(trust.status?.requests.first)
        XCTAssertEqual(request.code, v.text("p256", "code"))
        await trust.approve(request)
        XCTAssertNil(trust.problem)
        let sealed = try XCTUnwrap(FakeEdenServer.approved)
        let browser = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.data("p256", "private"))
        XCTAssertEqual(try EdenCrypto.open(sealedKey: sealed.sealedKey, senderKey: sealed.senderKey, with: browser), v.data("secret"))
    }

    func testASwappedKeyIsNeverSealedTo() async throws {
        let v = try vector()
        FakeEdenServer.turnOn(secret: v.data("secret"), wrap: v.json["passphrase"]?["wrap"] ?? .null)
        FakeEdenServer.browserAsks(publicKey: v.text("p256", "public"), alg: "p256")
        let trust = member()
        await trust.unlock(passphrase: v.text("passphrase", "passphrase"))
        let request = try XCTUnwrap(trust.status?.requests.first)
        FakeEdenServer.browserAsks(publicKey: P256.KeyAgreement.PrivateKey().publicKey.x963Representation.base64EncodedString(), alg: "p256")
        await trust.approve(request)
        XCTAssertEqual(trust.problem, "That browser’s key changed. Check its code again.")
        XCTAssertNil(FakeEdenServer.approved)
    }

    func testABrowserThatSyncsApprovesTheIPhone() async throws {
        let v = try vector()
        let secret = v.data("secret")
        FakeEdenServer.turnOn(secret: secret, wrap: .null)
        let keys = EdenKeyStore.memory()
        let trust = member(keys: keys)
        await trust.refresh()
        await trust.ask()
        let mine = try XCTUnwrap(FakeEdenServer.myRequest)
        XCTAssertEqual(trust.state, .asking(code: EdenCrypto.verifyCode(mine)), "the browser shows these same digits")
        // The browser that syncs approves: eden-crypto.js's sealTo, as the iPhone's own seal.
        FakeEdenServer.approveMine(try EdenCrypto.seal(secret, to: mine, alg: "x25519"))
        for _ in 0..<200 where trust.state != .on { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(trust.state, .on, trust.problem ?? "")
        XCTAssertEqual(keys.kept, EdenKeyStore.Kept(account: Self.account, gen: "gen-abcdef12", key: secret, epoch: 1))
        XCTAssertEqual(FakeEdenServer.mac, EdenCrypto.memberMac(secret, alg: "x25519", publicKey: mine), "it vouches for itself")
        XCTAssertEqual(FakeEdenServer.trustedVia, "approved")
        // Signed out: nothing of Eden sync stays.
        trust.signedOut()
        XCTAssertNil(keys.kept)
        XCTAssertNil(keys.read(EdenKeyStore.deviceAccount))
    }

    // MARK: - A device removed: Eden's key changes

    func testAKeyChangesMacsAndChainMatchTheBrowser() throws {
        let v = try vector()
        let secret = v.data("secret")
        let next = v.data("rotation", "next")
        XCTAssertEqual(EdenCrypto.memberMac(secret, alg: "x25519", publicKey: v.text("x25519", "public")), v.text("rotation", "mac", "x25519"))
        XCTAssertEqual(EdenCrypto.memberMac(secret, alg: "p256", publicKey: v.text("p256", "public")), v.text("rotation", "mac", "p256"))
        XCTAssertEqual(EdenCrypto.memberMac(next, alg: "x25519", publicKey: v.text("x25519", "public")), v.text("rotation", "next_mac", "x25519"))
        let link = try XCTUnwrap(v.json["rotation"]?["chain"]?.arrayValue?.first?["prev"]?.stringValue)
        XCTAssertEqual(try EdenCrypto.openChainLink(next, link: link, gen: "gen-abcdef12", epoch: 2), secret)
        XCTAssertNoThrow(try EdenCrypto.followRekey(next, epoch: 2, chain: [2: link], gen: "gen-abcdef12", mine: secret, from: 1))
        XCTAssertThrowsError(try EdenCrypto.openChainLink(next, link: link, gen: "gen-another1", epoch: 2))
        XCTAssertThrowsError(try EdenCrypto.followRekey(Data(count: 32), epoch: 2, chain: [2: link], gen: "gen-abcdef12", mine: secret, from: 1))
        XCTAssertThrowsError(try EdenCrypto.followRekey(next, epoch: 2, chain: [2: link], gen: "gen-abcdef12", mine: Data(count: 32), from: 1))
        XCTAssertThrowsError(try EdenCrypto.followRekey(next, epoch: 2, chain: [:], gen: "gen-abcdef12", mine: secret, from: 1))
    }

    func testTheIPhonePicksUpANewKeyThatFollowsFromItsOwn() async throws {
        let v = try vector()
        let secret = v.data("secret")
        let next = SymmetricKey(size: .bits256).data
        FakeEdenServer.turnOn(secret: secret, wrap: v.json["passphrase"]?["wrap"] ?? .null)
        let keys = EdenKeyStore.memory()
        let trust = member(keys: keys)
        await trust.unlock(passphrase: v.text("passphrase", "passphrase"))
        XCTAssertEqual(trust.state, .on, trust.problem ?? "")
        try FakeEdenServer.removeADevice(old: secret, new: next)
        await trust.refresh()
        XCTAssertEqual(trust.state, .on, trust.problem ?? "")
        XCTAssertNil(trust.problem)
        XCTAssertEqual(keys.kept?.key, next)
        XCTAssertEqual(keys.kept?.epoch, 2)
        XCTAssertEqual(FakeEdenServer.trustedVia, "passphrase", "how it joined stays")
        // It approves with the new key, vouching for the browser whose code matched.
        FakeEdenServer.browserAsks(publicKey: v.text("p256", "public"), alg: "p256")
        await trust.refresh()
        await trust.approve(try XCTUnwrap(trust.status?.requests.first))
        XCTAssertNil(trust.problem)
        let sealed = try XCTUnwrap(FakeEdenServer.approved)
        let browser = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.data("p256", "private"))
        XCTAssertEqual(try EdenCrypto.open(sealedKey: sealed.sealedKey, senderKey: sealed.senderKey, with: browser), next)
        XCTAssertEqual(FakeEdenServer.approvedMac, EdenCrypto.memberMac(next, alg: "p256", publicKey: v.text("p256", "public")))
    }

    func testANewKeyThatDoesntFollowFromTheIPhonesIsNeverUsed() async throws {
        let v = try vector()
        let secret = v.data("secret")
        FakeEdenServer.turnOn(secret: secret, wrap: v.json["passphrase"]?["wrap"] ?? .null)
        let keys = EdenKeyStore.memory()
        let trust = member(keys: keys)
        await trust.unlock(passphrase: v.text("passphrase", "passphrase"))
        // askeden.com seals a key of its own, with a chain made without the old key.
        let made = SymmetricKey(size: .bits256).data
        try FakeEdenServer.removeADevice(old: Data(count: 32), new: made, vouchAnyway: true)
        await trust.refresh()
        XCTAssertEqual(keys.kept?.key, secret)
        XCTAssertEqual(trust.problem?.hasPrefix("askeden.com offered a new Eden key"), true, trust.problem ?? "")
    }

    func testLeftOutOfAKeyChangeTheIPhoneDropsTheOldKey() async throws {
        let v = try vector()
        let secret = v.data("secret")
        FakeEdenServer.turnOn(secret: secret, wrap: v.json["passphrase"]?["wrap"] ?? .null)
        let keys = EdenKeyStore.memory()
        let trust = member(keys: keys)
        await trust.unlock(passphrase: v.text("passphrase", "passphrase"))
        try FakeEdenServer.removeADevice(old: secret, new: SymmetricKey(size: .bits256).data, sealToMine: false)
        await trust.refresh()
        XCTAssertNil(keys.kept)
        XCTAssertEqual(trust.state, .locked)
        XCTAssertEqual(trust.problem?.contains("left out"), true, trust.problem ?? "")
    }

    // MARK: - Against a local Worker (only when asked)

    /// The QA driver (docs/accounts.md, "The J.A.R.V.I.S. apps") starts `wrangler dev`, turns
    /// sync on in a "browser" with a passphrase, has a second one ask, and runs this with the
    /// iPhone's token; it then checks the second browser opens what this sealed.
    func testAgainstALocalWorker() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["EDEN_DEV_BASE"].flatMap(URL.init(string:)), let token = env["EDEN_DEV_TOKEN"],
              let passphrase = env["EDEN_DEV_PASSPHRASE"], let parsed = AccountCredential.parse(token) else {
            throw XCTSkip("Set EDEN_DEV_BASE, EDEN_DEV_TOKEN and EDEN_DEV_PASSPHRASE to run against wrangler dev.")
        }
        let config = URLSessionConfiguration.ephemeral
        let trust = EdenTrust(keys: .memory(), client: { AccountClient(base: base, token: token, session: URLSession(configuration: config)) }, accountID: { parsed.accountID })
        await trust.refresh()
        XCTAssertEqual(trust.state, .locked, trust.problem ?? "")
        await trust.unlock(passphrase: passphrase)
        XCTAssertEqual(trust.state, .on, trust.problem ?? "")
        let request = try XCTUnwrap(trust.status?.requests.first, "a browser should be waiting")
        print("EDEN_DEV approving \(request.name) \(request.code)")
        await trust.approve(request)
        XCTAssertNil(trust.problem)
        XCTAssertEqual(trust.done, "Approved. \(request.name) syncs Eden now.")
    }
}

/// askeden.com's /api/esync for one iPhone (in memory), with eden-sync.js's rules: only a trusted
/// device sees requests or approves; a proof must hash to the key's; an approval must echo the
/// key the request has.
final class FakeEdenServer: URLProtocol, @unchecked Sendable {
    private struct State {
        var proofHash = ""
        var gen = "gen-abcdef12"
        var wrap: JSONValue = .null
        var on = false
        var trustedVia: String?
        var browser: (publicKey: String, alg: String)?
        var mine: String?
        var mineApproved: EdenCrypto.Sealed?
        var approved: EdenCrypto.Sealed?
        var approvedMac: String?
        // A key change (eden-sync.js rotate): the epoch, the chain, this iPhone's mac and rekey.
        var epoch = 1
        var trustedEpoch = 1
        var chain: [JSONValue] = []
        var myPublic: String?
        var mac: String?
        var rekey: JSONValue = .null
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var state = State()

    static func reset() { lock.withLock { state = State() } }

    static func turnOn(secret: Data, wrap: JSONValue) {
        let proof = EdenCrypto.proof(of: secret)
        lock.withLock {
            state.on = true
            state.wrap = wrap
            state.proofHash = SHA256.hash(data: Data(proof.utf8)).map { String(format: "%02x", $0) }.joined()
        }
    }

    static func browserAsks(publicKey: String, alg: String) { lock.withLock { state.browser = (publicKey, alg) } }
    static func approveMine(_ sealed: EdenCrypto.Sealed) { lock.withLock { state.mineApproved = sealed } }
    static var myRequest: String? { lock.withLock { state.mine } }
    static var approved: EdenCrypto.Sealed? { lock.withLock { state.approved } }
    static var trustedVia: String? { lock.withLock { state.trustedVia } }
    static var mac: String? { lock.withLock { state.mac } }
    static var approvedMac: String? { lock.withLock { state.approvedMac } }

    /// What a browser's removeDevice does: the next epoch, the old key under the new one, and the
    /// new key sealed to this iPhone if its mac checks out under the old key (else it's dropped).
    static func removeADevice(old: Data, new: Data, sealToMine: Bool = true, vouchAnyway: Bool = false) throws {
        try lock.withLock {
            let epoch = state.epoch + 1
            let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: new), salt: Data(), info: Data("eden-chain-v1".utf8), outputByteCount: 32)
            let link = try AES.GCM.seal(old, using: key, authenticating: Data("eden-chain-v1:\(state.gen):\(epoch)".utf8)).combined!
            state.epoch = epoch
            state.chain.append(["epoch": .int(epoch), "prev": .string(link.base64EncodedString())])
            state.proofHash = SHA256.hash(data: Data(EdenCrypto.proof(of: new).utf8)).map { String(format: "%02x", $0) }.joined()
            state.wrap = .null
            guard let mine = state.myPublic, sealToMine,
                  vouchAnyway || state.mac == EdenCrypto.memberMac(old, alg: "x25519", publicKey: mine) else {
                state.trustedVia = nil
                return
            }
            let sealed = try EdenCrypto.seal(new, to: mine, alg: "x25519")
            state.rekey = ["epoch": .int(epoch), "sealed_key": .string(sealed.sealedKey), "sender_key": .string(sealed.senderKey), "alg": "x25519"]
            state.mac = EdenCrypto.memberMac(new, alg: "x25519", publicKey: mine)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "eden.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let (status, body) = Self.lock.withLock { handle() }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? body.encoded()) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    private var body: JSONValue {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            var collected = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                collected.append(buffer, count: count)
            }
            stream.close()
            data = collected
        }
        return data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? [:]
    }

    private func refuse(_ status: Int, _ code: String, _ words: String) -> (Int, JSONValue) {
        (status, ["error": .string(words), "code": .string(code)])
    }

    private func handle() -> (Int, JSONValue) {
        var s = Self.state
        defer { Self.state = s }
        let op = (request.url?.path ?? "").replacingOccurrences(of: "/api/esync", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let body = self.body
        let trusted = s.trustedVia != nil
        switch op {
        case "":
            var requests: [JSONValue] = []
            if trusted, let b = s.browser {
                requests.append(["device_id": "beef0000beef0000", "name": "Eden on the web: Safari on an iPhone", "kind": "web", "public_key": .string(b.publicKey), "alg": .string(b.alg), "status": "waiting"])
            }
            return (200, [
                "key": s.on ? ["gen": .string(s.gen), "wrap": .bool(s.wrap != .null), "epoch": .int(s.epoch)] : .null,
                "me": ["device_id": "a1b2c3d4e5f60718", "trusted": .bool(trusted), "epoch": .int(s.trustedEpoch), "mac": .bool(trusted && s.mac != nil), "rekey": trusted ? s.rekey : .null],
                "trusted": trusted ? [["name": "Bilel’s iPhone", "kind": "iphone", "this": true]] : [],
                "requests": .array(requests),
                "chain": .array(trusted ? s.chain : []),
            ])
        case "unwrap":
            guard s.wrap != .null else { return refuse(404, "no_wrap", "No passphrase.") }
            return (200, ["gen": .string(s.gen), "wrap": s.wrap])
        case "prove":
            let proof = body["proof"]?.stringValue ?? ""
            guard SHA256.hash(data: Data(proof.utf8)).map({ String(format: "%02x", $0) }).joined() == s.proofHash else {
                return refuse(403, "wrong_key", "That isn’t this account’s sync key.")
            }
            let same = s.trustedVia != nil && s.myPublic == body["public_key"]?.stringValue
            s.trustedVia = same ? s.trustedVia : body["via"]?.stringValue
            s.myPublic = body["public_key"]?.stringValue
            s.mac = body["mac"]?.stringValue ?? (same ? s.mac : nil)
            s.trustedEpoch = s.epoch
            s.rekey = .null
            s.mine = nil
            return (200, ["trusted": true, "epoch": .int(s.epoch)])
        case "request":
            s.mine = body["public_key"]?.stringValue
            return (200, ["status": "waiting"])
        case "poll":
            guard s.mine != nil else { return refuse(410, "expired", "Ran out.") }
            guard let sealed = s.mineApproved else { return (200, ["status": "waiting"]) }
            return (200, ["status": "approved", "sealed_key": .string(sealed.sealedKey), "sender_key": .string(sealed.senderKey), "alg": .string(sealed.alg), "by": "Eden on the web: Chrome on a Mac"])
        case "approve":
            guard trusted else { return refuse(403, "not_trusted", "Not trusted.") }
            guard s.trustedEpoch == s.epoch else { return refuse(409, "stale_key", "This device has Eden’s key from before.") }
            guard let b = s.browser, body["device_id"]?.stringValue == "beef0000beef0000" else { return refuse(404, "not_found", "Gone.") }
            guard body["public_key"]?.stringValue == b.publicKey else { return refuse(409, "conflict", "Key changed.") }
            s.approved = EdenCrypto.Sealed(sealedKey: body["sealed_key"]?.stringValue ?? "", senderKey: body["sender_key"]?.stringValue ?? "", alg: b.alg)
            s.approvedMac = body["mac"]?.stringValue
            s.browser = nil
            return (200, ["approved": true])
        case "deny":
            if body["device_id"] == nil { s.mine = nil } else { s.browser = nil }
            return (200, ["denied": true])
        case "untrust":
            s.trustedVia = nil
            return (200, ["untrusted": "a1b2c3d4e5f60718"])
        default:
            return refuse(404, "not_found", "No such thing.")
        }
    }
}
