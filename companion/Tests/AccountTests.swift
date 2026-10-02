import CryptoKit
import XCTest
@testable import JarvisCompanion

/// The optional Jarvis account (docs/accounts.md): its credential and JSON, link codes, the
/// sealing for sync and for handing a Mac the sync key, memory merging, the relay tunnel's
/// byte copying, the route to the Mac, and what a spent allowance says.
final class AccountTests: XCTestCase {
    private let token = "jv1.0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60.a1b2c3d4e5f60718.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"

    // MARK: - Credential

    func testTokenParsesIntoAccountAndDevice() throws {
        let credential = try XCTUnwrap(AccountCredential.parse(token))
        XCTAssertEqual(credential.accountID, "0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60")
        XCTAssertEqual(credential.deviceID, "a1b2c3d4e5f60718")
        XCTAssertEqual(credential.token, token)
    }

    func testTokensThatArentOursAreRefused() {
        XCTAssertNil(AccountCredential.parse(""))
        XCTAssertNil(AccountCredential.parse(token.replacingOccurrences(of: "jv1.", with: "jv2.")))
        XCTAssertNil(AccountCredential.parse(token.uppercased()))  // ids are lowercase
        XCTAssertNil(AccountCredential.parse(token + "x"))  // a 44-character secret
        XCTAssertNil(AccountCredential.parse("jv1.0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60.a1b2c3d4e5f6071.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"))
        XCTAssertNil(AccountCredential.parse("jv1.not-a-uuid.a1b2c3d4e5f60718.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"))
        XCTAssertNil(AccountCredential.parse(token + ".extra"))
    }

    func testCredentialKeepsTheContractsKeychainShape() throws {
        let credential = try XCTUnwrap(AccountCredential.parse(token))
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(credential))
        XCTAssertEqual(json["token"]?.stringValue, token)
        XCTAssertEqual(json["accountID"]?.stringValue, credential.accountID)
        XCTAssertEqual(json["deviceID"]?.stringValue, credential.deviceID)
    }

    func testAccountIDFromAppleIsAVersion8UUID() {
        let id = AccountCredential.accountID(appleUserID: "001234.abcdef0123456789.1234")
        XCTAssertTrue(AccountCredential.isAccountID(id), id)
        let characters = Array(id)
        XCTAssertEqual(characters[14], "8")  // version nibble
        XCTAssertTrue("89ab".contains(characters[19]))  // RFC 4122 variant
        XCTAssertEqual(id, AccountCredential.accountID(appleUserID: "001234.abcdef0123456789.1234"))
        XCTAssertNotEqual(id, AccountCredential.accountID(appleUserID: "001234.abcdef0123456789.1235"))
        // The first 16 bytes of SHA-256("jarvis-account-v1:" + sub), but for those 6 bits.
        let digest = Array(SHA256.hash(data: Data("jarvis-account-v1:001234.abcdef0123456789.1234".utf8)))
        let hex = id.replacingOccurrences(of: "-", with: "")
        XCTAssertEqual(String(hex.prefix(12)), digest.prefix(6).map { String(format: "%02x", $0) }.joined())
    }

    func testNonceHashIsSHA256Hex() {
        XCTAssertEqual(SignInNonce.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let nonce = SignInNonce.make()
        XCTAssertEqual(nonce.count, 43)
        XCTAssertNotEqual(nonce, SignInNonce.make())
    }

    // MARK: - Account JSON

    func testAccountDecodesTheContractsExample() throws {
        let json = """
        {"id": "0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60", "created": 1790000000000,
         "plan": {"name": "plus", "active": true, "product_id": "com.bshventures.jarvis.plus.monthly",
                  "expires": 1792000000000, "renews": true, "environment": "Sandbox"},
         "usage": {"period_start": 1790000000000, "period_end": null, "spent_usd": 0.42, "budget_usd": 20,
                   "left_usd": 19.58, "trial_left_usd": 1.0, "voice_today": 1200, "voice_daily": 100000},
         "devices": [
           {"id": "a1b2c3d4e5f60718", "name": "Bilel's iPhone", "kind": "iphone", "created": 1790000000000,
            "last_seen": 1790000100000, "app_version": "1.0 (1)", "push": true, "relay": false, "this": true},
           {"id": "0011223344556677", "name": "Bilel's MacBook Air", "kind": "mac", "created": 1790000000000,
            "last_seen": null, "app_version": "0.1.6", "push": false, "relay": true, "this": false}],
         "sync": {"rev": 12, "items": 5}}
        """
        let account = try JSONDecoder().decode(Account.self, from: Data(json.utf8))
        XCTAssertEqual(account.id, "0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60")
        XCTAssertEqual(account.created, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertTrue(account.plan.isPlus)
        XCTAssertEqual(account.plan.productID, "com.bshventures.jarvis.plus.monthly")
        XCTAssertEqual(account.plan.expires, Date(timeIntervalSince1970: 1_792_000_000))
        XCTAssertEqual(account.plan.renews, true)
        XCTAssertEqual(account.usage.spentUSD, 0.42, accuracy: 0.0001)
        XCTAssertEqual(account.usage.budgetUSD, 20)
        XCTAssertEqual(account.usage.leftUSD, 19.58, accuracy: 0.0001)
        XCTAssertEqual(account.usage.trialLeftUSD, 1)
        XCTAssertEqual(account.usage.voiceToday, 1200)
        XCTAssertEqual(account.usage.spentFraction, 0.021, accuracy: 0.0001)
        XCTAssertNil(account.usage.periodEnd)
        XCTAssertEqual(account.devices.count, 2)
        XCTAssertEqual(account.thisDevice?.name, "Bilel's iPhone")
        XCTAssertEqual(account.macs.map(\.id), ["0011223344556677"])
        XCTAssertEqual(account.macs.first?.symbol, "laptopcomputer")
        XCTAssertTrue(account.macs.first?.relay ?? false)
        XCTAssertNil(account.macs.first?.lastSeen)
        XCTAssertEqual(account.sync.rev, 12)
        XCTAssertEqual(account.sync.items, 5)
        XCTAssertTrue(account.hasAllowance)
    }

    func testAFreeAccountWithMissingPartsStillReads() throws {
        let account = try JSONDecoder().decode(Account.self, from: Data(#"{"id":"0F8E2A64-5C1B-8D3E-9A7F-1B2C3D4E5F60","plan":{"name":"free","active":false},"usage":{"trial_left_usd":"0.73"}}"#.utf8))
        XCTAssertEqual(account.id, "0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60")
        XCTAssertFalse(account.plan.isPlus)
        XCTAssertEqual(account.usage.trialLeftUSD, 0.73, accuracy: 0.0001)
        XCTAssertTrue(account.devices.isEmpty)
        XCTAssertTrue(account.hasAllowance)
        XCTAssertThrowsError(try JSONDecoder().decode(Account.self, from: Data(#"{"plan":{}}"#.utf8)))
    }

    func testSignInAnswerReads() throws {
        let json = #"{"token":"\#(token)","account":{"id":"0f8e2a64-5c1b-8d3e-9a7f-1b2c3d4e5f60"},"device_id":"a1b2c3d4e5f60718","new":true}"#
        let result = try JSONDecoder().decode(AccountClient.SignIn.self, from: Data(json.utf8))
        XCTAssertEqual(result.deviceID, "a1b2c3d4e5f60718")
        XCTAssertTrue(result.isNew)
        XCTAssertEqual(AccountCredential.parse(result.token)?.accountID, result.account.id)
    }

    func testErrorsReadAsWordsForAPerson() {
        func error(_ status: Int, _ body: String, retry: String? = nil) -> AccountError {
            AccountError.from(status: status, body: Data(body.utf8), retryAfter: retry)
        }
        XCTAssertEqual(error(401, #"{"error":"Signed out.","code":"signed_out"}"#), .signedOut)
        XCTAssertEqual(error(404, #"{"error":"Your Mac is offline.","code":"offline"}"#), .offline)
        XCTAssertEqual(error(404, #"{"error":"No such code.","code":"not_found"}"#), .notFound("No such code."))
        XCTAssertEqual(error(410, #"{"error":"x","code":"denied"}"#), .expired("The link was turned down."))
        XCTAssertEqual(error(429, #"{"error":"x","code":"slow_down"}"#, retry: "30"), .slowDown(retryAfter: 30))
        XCTAssertEqual(error(503, #"{"error":"x","code":"not_set_up"}"#), .notSetUp)
        XCTAssertEqual(error(402, #"{"type":"error","error":{"type":"billing_error","message":"Spent."}}"#), .noAllowance("Spent."))
        XCTAssertEqual(error(500, "not json"), .server(500, nil))
        for case let described? in [AccountError.signedOut, .offline, .notSetUp, .slowDown(retryAfter: nil)].map(\.errorDescription) {
            XCTAssertFalse(described.contains("_"), described)  // never a machine code on screen
        }
    }

    // MARK: - Included AI

    func testASpentAllowanceSaysWhatToDo() {
        let body = Data(#"{"type":"error","error":{"type":"billing_error","message":"No allowance left."}}"#.utf8)
        let failure = ClaudeClient.failure(status: 402, body: body, viaAccount: true)
        XCTAssertEqual(failure, .noAllowance)
        XCTAssertTrue(failure.errorDescription?.contains("Upgrade to Jarvis Plus") ?? false)
        XCTAssertEqual(ClaudeClient.failure(status: 401, body: Data(), viaAccount: true), .signedOut)
        XCTAssertEqual(ClaudeClient.failure(status: 401, body: Data()), .badKey)  // the owner's own key
    }

    func testTheAccountCredentialPointsClaudeAtTheProxy() {
        var request = URLRequest(url: ClaudeClient.Credential.account(token: token).endpoint)
        ClaudeClient.Credential.account(token: token).authorize(&request)
        XCTAssertEqual(request.url?.absoluteString, "https://askeden.com/api/anthropic/v1/messages")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertNil(request.value(forHTTPHeaderField: "x-api-key"))

        var own = URLRequest(url: ClaudeClient.Credential.apiKey("sk-ant-x").endpoint)
        ClaudeClient.Credential.apiKey("sk-ant-x").authorize(&own)
        XCTAssertEqual(own.url?.host, "api.anthropic.com")
        XCTAssertEqual(own.value(forHTTPHeaderField: "x-api-key"), "sk-ant-x")
        XCTAssertNil(own.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - Link codes

    func testLinkCodesReadHoweverTheyreTyped() {
        XCTAssertEqual(LinkCode.normalize("K7QM-4ZTR"), "K7QM-4ZTR")
        XCTAssertEqual(LinkCode.normalize("k7qm4ztr"), "K7QM-4ZTR")
        XCTAssertEqual(LinkCode.normalize(" k7qm 4ztr "), "K7QM-4ZTR")
        XCTAssertEqual(LinkCode.normalize("jarvis-link://K7QM-4ZTR"), "K7QM-4ZTR")
        XCTAssertEqual(LinkCode.fromQR("JARVIS-LINK://k7qm-4ztr"), "K7QM-4ZTR")
        XCTAssertNil(LinkCode.fromQR("K7QM-4ZTR"))  // a QR code has to say what it is
        XCTAssertNil(LinkCode.normalize("K7QM-4ZTI"))  // no I, L, O or U
        XCTAssertNil(LinkCode.normalize("K7QM-4ZT"))
        XCTAssertNil(LinkCode.normalize("jarvis-pair://192.168.1.2:8765?code=123456"))
    }

    // MARK: - Sealing

    func testSyncSealRoundTripsAndIsBoundToItsKey() throws {
        let key = SymmetricKey(size: .bits256)
        let plain = Data(#"{"v":1,"facts":[]}"#.utf8)
        let sealed = try SyncSeal.seal(plain, key: key, itemKey: "memory")
        let raw = try XCTUnwrap(Data(base64Encoded: sealed))
        XCTAssertEqual(raw.count, 12 + plain.count + 16)  // nonce ‖ ciphertext ‖ tag
        XCTAssertEqual(try SyncSeal.open(sealed, key: key, itemKey: "memory"), plain)
        // Moved to another item's key, or opened with another key, it doesn't open.
        XCTAssertThrowsError(try SyncSeal.open(sealed, key: key, itemKey: "settings")) { error in
            XCTAssertEqual(error as? SyncSeal.Failure, .wrongKey)
        }
        XCTAssertThrowsError(try SyncSeal.open(sealed, key: SymmetricKey(size: .bits256), itemKey: "memory"))
        XCTAssertThrowsError(try SyncSeal.open("not base64!", key: key, itemKey: "memory")) { error in
            XCTAssertEqual(error as? SyncSeal.Failure, .unreadable)
        }
        XCTAssertNotEqual(sealed, try SyncSeal.seal(plain, key: key, itemKey: "memory"))  // a fresh nonce each time
    }

    /// Fixed keys, so the Mac (Python's `cryptography`) can check it opens the same bytes:
    /// Fixtures/link-seal-vector.json.
    private func linkVector() throws -> (mac: Curve25519.KeyAgreement.PrivateKey, sender: Curve25519.KeyAgreement.PrivateKey,
                                         nonce: Data, syncKey: Data) {
        let mac = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data((1...32).map { UInt8($0) }))
        let sender = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data((33...64).map { UInt8($0) }))
        return (mac, sender, Data((65...76).map { UInt8($0) }), Data((128...159).map { UInt8($0) }))
    }

    func testLinkSealOpensOnlyForTheMac() throws {
        let vector = try linkVector()
        let sealed = try LinkSeal.seal(
            syncKey: vector.syncKey, macPublicKey: vector.mac.publicKey.rawRepresentation.base64EncodedString(),
            sender: vector.sender, nonce: ChaChaPoly.Nonce(data: vector.nonce)
        )
        XCTAssertEqual(sealed.senderKey, vector.sender.publicKey.rawRepresentation.base64EncodedString())
        XCTAssertEqual(try LinkSeal.open(sealed: sealed, macPrivate: vector.mac), vector.syncKey)

        // Exactly the contract: X25519, HKDF-SHA256 (empty salt, info "jarvis-link-v1"), and
        // ChaCha20-Poly1305 with the same aad, as nonce ‖ ciphertext ‖ tag.
        let shared = try vector.mac.sharedSecretFromKeyAgreement(with: vector.sender.publicKey)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data("jarvis-link-v1".utf8), outputByteCount: 32)
        let raw = try XCTUnwrap(Data(base64Encoded: sealed.sealedKey))
        XCTAssertEqual(raw.count, 12 + 32 + 16)
        XCTAssertEqual(raw.prefix(12), vector.nonce)
        let box = try ChaChaPoly.SealedBox(combined: raw)
        XCTAssertEqual(try ChaChaPoly.open(box, using: key, authenticating: Data("jarvis-link-v1".utf8)), vector.syncKey)
        XCTAssertThrowsError(try ChaChaPoly.open(box, using: key, authenticating: Data()))  // the aad is bound

        // Another Mac can't open it.
        let other = Curve25519.KeyAgreement.PrivateKey()
        XCTAssertThrowsError(try LinkSeal.open(sealed: sealed, macPrivate: other))
        XCTAssertThrowsError(try LinkSeal.seal(syncKey: vector.syncKey, macPublicKey: "c2hvcnQ="))

        // The vector the Mac's tests read.
        let fixture: JSONValue = [
            "about": "docs/accounts.md: sealing the sync key to the Mac. All values base64 (standard, padded).",
            "info": "jarvis-link-v1",
            "mac_private": .string(vector.mac.rawRepresentation.base64EncodedString()),
            "mac_public": .string(vector.mac.publicKey.rawRepresentation.base64EncodedString()),
            "sender_private": .string(vector.sender.rawRepresentation.base64EncodedString()),
            "sender_public": .string(sealed.senderKey),
            "nonce": .string(vector.nonce.base64EncodedString()),
            "sync_key": .string(vector.syncKey.base64EncodedString()),
            "sealed_key": .string(sealed.sealedKey),
        ]
        if let url = Bundle(for: Self.self).url(forResource: "link-seal-vector", withExtension: "json") {
            let kept = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
            XCTAssertEqual(kept, fixture, "Fixtures/link-seal-vector.json no longer matches what the iPhone seals")
        } else {
            let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/link-seal-vector.json")
            var data = try fixture.encoded()
            data.append(Data("\n".utf8))
            try data.write(to: source)
            XCTFail("Wrote \(source.path); run again")
        }
    }

    // MARK: - Memory

    func testMemoryMergesByIDAndTheLaterWins() {
        let now = Date()
        let ms = SyncItems.ms(now)
        let mine = [
            SyncItems.WireFact(id: "a", text: "Likes tea", category: "preferences", updated: ms - 5000),
            SyncItems.WireFact(id: "b", text: "Ann is a sister", category: "people", updated: ms - 4000),
            SyncItems.WireFact(id: "c", text: "", category: "other", updated: ms - 1000, deleted: true),
        ]
        let theirs = [
            SyncItems.WireFact(id: "a", text: "Likes green tea", category: "preferences", updated: ms - 2000),  // newer edit
            SyncItems.WireFact(id: "b", text: "", category: "people", updated: ms - 6000, deleted: true),  // older delete
            SyncItems.WireFact(id: "c", text: "Runs on Sundays", category: "health", updated: ms - 3000),  // deleted here since
            SyncItems.WireFact(id: "d", text: "Works at Stark", category: "work", updated: ms - 3000),
            SyncItems.WireFact(id: "e", text: "", category: "other", updated: ms - 100 * 24 * 3600 * 1000, deleted: true),  // too old
        ]
        let merged = SyncItems.merge(mine, theirs, now: now)
        let byID = Dictionary(uniqueKeysWithValues: merged.map { ($0.id, $0) })
        XCTAssertEqual(Set(byID.keys), ["a", "b", "c", "d"])
        XCTAssertEqual(byID["a"]?.text, "Likes green tea")
        XCTAssertEqual(byID["b"]?.deleted, false)
        XCTAssertEqual(byID["c"]?.deleted, true)
        XCTAssertEqual(byID["d"]?.category, "work")
        // Merging is the same either way round.
        XCTAssertEqual(Set(SyncItems.merge(theirs, mine, now: now).map(\.id)), Set(byID.keys))
        // On a tie, the delete wins.
        let tie = SyncItems.merge([.init(id: "x", text: "Hi", category: "other", updated: ms)],
                                  [.init(id: "x", text: "", category: "other", updated: ms, deleted: true)], now: now)
        XCTAssertEqual(tie.first?.deleted, true)
    }

    @MainActor
    func testLocalMemoryGoesOnTheWireWithCategoriesAndTombstones() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let memory = LocalMemory(folder: folder)
        memory.add("Prefers metric units", kind: .preference)
        memory.add("Pepper is the owner's partner", kind: .person)
        memory.add("Wants to run a marathon", kind: .goal)
        memory.add("Never book red-eyes", kind: .correction)
        memory.add("Lives in Malibu")
        let categories = Dictionary(uniqueKeysWithValues: memory.wireFacts.map { ($0.text, $0.category) })
        XCTAssertEqual(categories["Prefers metric units"], "preferences")
        XCTAssertEqual(categories["Pepper is the owner's partner"], "people")
        XCTAssertEqual(categories["Wants to run a marathon"], "goals")
        XCTAssertEqual(categories["Never book red-eyes"], "corrections")
        XCTAssertEqual(categories["Lives in Malibu"], "other")
        XCTAssertTrue(memory.wireFacts.allSatisfy { UUID(uuidString: $0.id) != nil && $0.id == $0.id.lowercased() })

        let gone = try XCTUnwrap(memory.facts.first { $0.text == "Lives in Malibu" })
        memory.remove(gone)
        let tombstone = try XCTUnwrap(memory.wireFacts.first { $0.id == gone.id.uuidString.lowercased() })
        XCTAssertTrue(tombstone.deleted)
        XCTAssertGreaterThanOrEqual(tombstone.updated, SyncItems.ms(gone.date))

        // A Mac's category the iPhone has no kind for keeps it on the way back.
        let workID = UUID()
        memory.applySynced(memory.wireFacts + [.init(id: workID.uuidString.lowercased(), text: "Board meeting Mondays", category: "work", updated: 1)])
        XCTAssertEqual(memory.facts.first { $0.id == workID }?.category, .fact)
        XCTAssertEqual(memory.wireFacts.first { $0.id == workID.uuidString.lowercased() }?.category, "work")
        XCTAssertTrue(memory.prompt.contains("Board meeting Mondays"))
        XCTAssertFalse(memory.prompt.contains("Malibu"))

        // Kept across launches, tombstones included.
        let again = LocalMemory(folder: folder)
        XCTAssertEqual(again.facts.count, memory.facts.count)
        XCTAssertEqual(again.deleted.keys.first, gone.id)
    }

    func testSettingsKeepFieldsTheyDontKnow() throws {
        let theirs = try XCTUnwrap(SyncItems.Settings(json: Data(#"{"v":1,"updated":1790000000000,"owner_name":"Tony","language":"en","address_as":"boss"}"#.utf8)))
        XCTAssertEqual(theirs.updated, 1_790_000_000_000)
        XCTAssertEqual(theirs.addressAs, "boss")
        var mine = theirs
        mine.addressAs = "Tony"
        let back = try JSONDecoder().decode(JSONValue.self, from: mine.encoded())
        XCTAssertEqual(back["owner_name"]?.stringValue, "Tony")
        XCTAssertEqual(back["language"]?.stringValue, "en")
        XCTAssertEqual(back["address_as"]?.stringValue, "Tony")
        XCTAssertEqual(back["v"]?.intValue, 1)
    }

    func testChatsGoOnTheWireAndComeBack() throws {
        let id = UUID()
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        let saved = SavedChat(
            id: id, title: "Weather", created: start, updated: start.addingTimeInterval(30), pinned: true,
            messages: [], lines: [
                .init(role: "user", text: "Weather?", time: start, pictures: [Data([1, 2])]),
                .init(role: "jarvis", text: "Sunny.", time: start.addingTimeInterval(2)),
                .init(role: "problem", text: "Couldn't reach Claude", time: start.addingTimeInterval(3)),
            ]
        )
        let wire = SyncItems.chat(from: saved)
        XCTAssertEqual(SyncItems.chatKey(id), "chat:" + id.uuidString.lowercased())
        XCTAssertEqual(SyncItems.chatID(fromKey: SyncItems.chatKey(id)), id)
        XCTAssertEqual(wire.messages.map(\.role), ["user", "assistant"])  // problems stay here
        XCTAssertEqual(wire.updated, 1_790_000_030_000)
        let json = try JSONDecoder().decode(JSONValue.self, from: SyncItems.encode(wire))
        XCTAssertEqual(json["v"]?.intValue, 1)
        XCTAssertEqual(json["messages"]?.arrayValue?.first?["at"]?.intValue, 1_790_000_000_000)
        XCTAssertNil(json["project"])

        let back = try XCTUnwrap(SyncItems.savedChat(from: wire, existing: saved))
        XCTAssertTrue(back.pinned)  // this iPhone's own
        XCTAssertEqual(back.lines.first?.pictures, [Data([1, 2])])
        XCTAssertEqual(back.messages.count, 2)
        XCTAssertEqual(back.messages.last?["role"]?.stringValue, "assistant")
        XCTAssertEqual(SyncItems.chat(from: back), wire)  // the same bytes again: not sent twice
    }

    // MARK: - Relay tunnel

    func testRelayPumpCopiesBothWaysAndClosesBoth() async {
        let local = FakeSocket(incoming: [Data("GET /api/state".utf8), Data(repeating: 7, count: 150_000)])
        let mac = FakeSocket(incoming: [Data("HTTP/1.1 200".utf8)], holdOpen: true)
        let heard = await RelayPump.run(local: local, upstream: mac)
        XCTAssertTrue(heard)
        XCTAssertEqual(local.sent, [Data("HTTP/1.1 200".utf8)])
        XCTAssertEqual(mac.sent.first, Data("GET /api/state".utf8))
        XCTAssertEqual(mac.sent.dropFirst().map(\.count), [65536, 65536, 18928])  // no frame over 64 KiB
        XCTAssertTrue(local.closed)
        XCTAssertTrue(mac.closed)
    }

    func testARelayStreamThatNeverHearsTheMacSaysSo() async {
        let local = FakeSocket(incoming: [Data("hello".utf8)], holdOpen: true)
        let refused = FakeSocket(incoming: [])  // askeden.com closed it: the Mac isn't there
        let heard = await RelayPump.run(local: local, upstream: refused)
        XCTAssertFalse(heard)
        XCTAssertTrue(local.closed)
    }

    func testTheTunnelListensOnLoopbackAndCarriesBytes() async throws {
        let mac = FakeSocket(incoming: [Data("pong".utf8)], holdOpen: true)
        let tunnel = RelayTunnel(macDeviceID: "0011223344556677") { mac }
        let port = try await tunnel.start()
        defer { tunnel.stop() }
        XCTAssertGreaterThan(port, 0)

        // A plain TCP client, as URLSession would connect.
        let task = URLSession.shared.streamTask(withHostName: "127.0.0.1", port: Int(port))
        task.resume()
        try await task.write(Data("ping".utf8), timeout: 5)
        let (reply, _) = try await task.readData(ofMinLength: 4, maxLength: 64, timeout: 5)
        XCTAssertEqual(reply, Data("pong".utf8))
        for _ in 0..<50 where mac.sent.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(mac.sent, [Data("ping".utf8)])
        task.cancel()
    }

    // MARK: - The route to the Mac

    func testRouteDecisions() {
        XCTAssertEqual(MacRouter.decide(directReachable: true, signedIn: true, macDeviceID: "m", relayRefused: false), .direct)
        XCTAssertEqual(MacRouter.decide(directReachable: false, signedIn: true, macDeviceID: "m", relayRefused: false), .relay)
        XCTAssertEqual(MacRouter.decide(directReachable: false, signedIn: false, macDeviceID: "m", relayRefused: false), .direct)
        XCTAssertEqual(MacRouter.decide(directReachable: false, signedIn: true, macDeviceID: nil, relayRefused: false), .direct)
        XCTAssertEqual(MacRouter.decide(directReachable: false, signedIn: true, macDeviceID: "", relayRefused: false), .direct)
        // The relay just turned a stream down: straight to the address, which fails as it
        // always has, so the iPhone answers instead.
        XCTAssertEqual(MacRouter.decide(directReachable: false, signedIn: true, macDeviceID: "m", relayRefused: true), .direct)
    }

    func testRouterSendsThroughTheRelayOnlyWhenTheAddressDoesntAnswer() async throws {
        let direct = try XCTUnwrap(URL(string: "https://192.168.1.20:8765"))
        let reachable = Flag(true)
        let router = MacRouter(knock: { _, _ in reachable.value })
        await router.configure(direct: direct, macDeviceID: "0011223344556677", signedIn: true)

        let first = await router.base(for: direct)
        XCTAssertEqual(first, direct)
        let relaying = await router.isRelaying
        XCTAssertFalse(relaying)

        // Another Mac's address, or the wake listener's port, always goes straight.
        let other = try XCTUnwrap(URL(string: "https://192.168.1.20:8764"))
        let otherBase = await router.base(for: other)
        XCTAssertEqual(otherBase, other)

        // The address stops answering (and the knock is remembered for 30 s, so it's asked
        // again only after a fresh router or a network change).
        reachable.value = false
        let fresh = MacRouter(knock: { _, _ in reachable.value })
        await fresh.configure(direct: direct, macDeviceID: "0011223344556677", signedIn: true)
        let relay = await fresh.base(for: direct)
        XCTAssertEqual(relay.host, "127.0.0.1")
        XCTAssertEqual(relay.scheme, "https")
        XCTAssertNotNil(relay.port)
        let nowRelaying = await fresh.isRelaying
        XCTAssertTrue(nowRelaying)

        // A request that couldn't reach the address goes once more through the relay.
        let retry = await router.directFailed(direct)
        XCTAssertEqual(retry?.host, "127.0.0.1")

        // Signed out: never the relay.
        await fresh.configure(direct: direct, macDeviceID: "0011223344556677", signedIn: false)
        let signedOut = await fresh.base(for: direct)
        XCTAssertEqual(signedOut, direct)
        let noRetry = await fresh.directFailed(direct)
        XCTAssertNil(noRetry)
    }

    func testTheMacsAccountDeviceComesWithItsState() throws {
        let linked = try JSONDecoder().decode(RemoteState.self, from: Data(#"{"state":"idle","account":{"device_id":"0011223344556677"}}"#.utf8))
        XCTAssertEqual(linked.accountDeviceID, "0011223344556677")
        let unlinked = try JSONDecoder().decode(RemoteState.self, from: Data(#"{"state":"idle"}"#.utf8))
        XCTAssertNil(unlinked.accountDeviceID)
        // A pairing kept before accounts reads, without the Mac's device id.
        let old = #"{"baseURL":"https://192.168.1.20:8765","token":"t","pairedAt":0,"fingerprint":"\#(String(repeating: "a", count: 64))"}"#
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data(old.utf8))
        XCTAssertNil(pairing.macDeviceID)
    }

    func testARequestThatCantReachTheMacTriesTheRelayOnce() async throws {
        let router = RecordingRouter()
        MacRoute.router = router
        defer { MacRoute.router = nil }
        // Port 1 on loopback refuses at once: never delivered, so the relay gets a try (here
        // another refusing port, so it fails the same way).
        let api = JarvisAPI(baseURL: try XCTUnwrap(URL(string: "https://127.0.0.1:1")), token: "t", fingerprint: String(repeating: "a", count: 64))
        do {
            _ = try await api.state()
            XCTFail("Nothing listens there")
        } catch let error as JarvisError {
            XCTAssertTrue(error.neverDelivered, "\(error)")
        }
        let calls = router.calls
        XCTAssertEqual(calls.first, "base")
        XCTAssertTrue(calls.contains("directFailed"), "\(calls)")
    }
}

/// A socket that hands out what it was given, then closes (or waits to be closed).
private final class FakeSocket: RelaySocket, @unchecked Sendable {
    private let lock = NSLock()
    private var incoming: [Data]
    private let holdOpen: Bool
    private var waiting: CheckedContinuation<Data?, Error>?
    private(set) var sent: [Data] = []
    private(set) var closed = false

    init(incoming: [Data], holdOpen: Bool = false) {
        self.incoming = incoming
        self.holdOpen = holdOpen
    }

    func receive() async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !incoming.isEmpty {
                let next = incoming.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
            } else if closed || !holdOpen {
                lock.unlock()
                continuation.resume(returning: nil)
            } else {
                waiting = continuation
                lock.unlock()
            }
        }
    }

    func send(_ data: Data) async throws {
        lock.withLock { sent.append(data) }
    }

    func close() {
        let continuation = lock.withLock {
            closed = true
            defer { waiting = nil }
            return waiting
        }
        continuation?.resume(returning: nil)
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool
    init(_ value: Bool) { stored = value }
    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// A router that sends a retry to another closed port, and notes what it was asked.
private final class RecordingRouter: MacRoute.Router, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var calls: [String] { lock.withLock { recorded } }

    func base(for direct: URL) async -> URL {
        lock.withLock { recorded.append("base") }
        return direct
    }

    func directFailed(_ direct: URL) async -> URL? {
        lock.withLock { recorded.append("directFailed") }
        return URL(string: "https://127.0.0.1:2")
    }

    func relayFailed(_ base: URL) async -> Bool {
        lock.withLock { recorded.append("relayFailed") }
        return true
    }
}
