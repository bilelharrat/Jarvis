import CryptoKit
import XCTest
@testable import JarvisCompanion

/// Sync end to end against a stand-in for askeden.com (an in-memory store behind
/// URLProtocol): two iPhones on one account and one sync key, memory merging, chats coming
/// and going, a write that loses a race, and a device with the wrong key.
@MainActor
final class SyncEngineTests: XCTestCase {
    private var folders: [URL] = []

    override func setUp() {
        super.setUp()
        FakeSyncServer.reset()
    }

    override func tearDown() {
        for folder in folders { try? FileManager.default.removeItem(at: folder) }
        FakeSyncServer.reset()
        super.tearDown()
    }

    private struct Device {
        var engine: SyncEngine
        var memory: LocalMemory
        var chats: ChatStore
    }

    private func device(key: SymmetricKey?) -> Device {
        let folder = FileManager.default.temporaryDirectory.appending(path: "sync-\(UUID().uuidString)")
        folders.append(folder)
        let memory = LocalMemory(folder: folder)
        let chats = ChatStore(folder: folder)
        let defaults = UserDefaults(suiteName: "sync-tests-\(UUID().uuidString)")!
        defaults.set(true, forKey: SyncEngine.enabledKey)
        let engine = SyncEngine(memory: memory, chats: chats, defaults: defaults)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeSyncServer.self]
        let client = AccountClient(base: URL(string: "https://askeden.test/api")!, token: "jv1.test", session: URLSession(configuration: configuration))
        engine.client = { client }
        var made = key
        engine.loadKey = { made }
        engine.makeKey = {
            let fresh = SymmetricKey(size: .bits256)
            made = fresh
            return fresh
        }
        return Device(engine: engine, memory: memory, chats: chats)
    }

    private func chat(_ question: String, _ answer: String) -> (UUID, [SavedChat.Line]) {
        let now = Date()
        return (UUID(), [.init(role: "user", text: question, time: now), .init(role: "jarvis", text: answer, time: now)])
    }

    func testTwoIPhonesShareMemoryAndChats() async throws {
        let key = SymmetricKey(size: .bits256)
        let first = device(key: key)
        first.memory.add("Prefers tea", kind: .preference)
        let (chatID, lines) = chat("What's the weather?", "Sunny.")
        first.chats.keep(id: chatID, messages: [], lines: lines)
        await first.engine.sync()
        XCTAssertEqual(first.engine.status, .idle)
        XCTAssertEqual(Set(FakeSyncServer.keys), ["keycheck", "memory", SyncItems.chatKey(chatID)])
        // askeden.com only ever holds sealed bytes.
        XCTAssertFalse(FakeSyncServer.allData.contains { String(data: Data(base64Encoded: $0) ?? Data(), encoding: .utf8)?.contains("tea") == true })

        let second = device(key: key)
        await second.engine.sync()
        XCTAssertEqual(second.engine.status, .idle)
        XCTAssertEqual(second.memory.facts.map(\.text), ["Prefers tea"])
        XCTAssertEqual(second.memory.facts.first?.category, .preference)
        XCTAssertEqual(second.chats.chat(chatID)?.lines.map(\.text), ["What's the weather?", "Sunny."])

        // Both learn something; each sync brings the other's.
        first.memory.add("Runs on Sundays", kind: .fact)
        second.memory.add("Ann is a sister", kind: .person)
        await first.engine.sync()
        await second.engine.sync()
        await first.engine.sync()
        XCTAssertEqual(Set(first.memory.facts.map(\.text)), ["Prefers tea", "Runs on Sundays", "Ann is a sister"])
        XCTAssertEqual(Set(second.memory.facts.map(\.text)), Set(first.memory.facts.map(\.text)))

        // Forgotten on one, forgotten on both; a deleted chat goes too.
        let tea = try XCTUnwrap(second.memory.facts.first { $0.text == "Prefers tea" })
        second.memory.remove(tea)
        second.chats.delete(chatID)
        await second.engine.sync()
        await first.engine.sync()
        XCTAssertFalse(first.memory.facts.contains { $0.text == "Prefers tea" })
        XCTAssertNil(first.chats.chat(chatID))

        // Nothing changed: nothing is sent again.
        let writes = FakeSyncServer.writes
        await first.engine.sync()
        await second.engine.sync()
        XCTAssertEqual(FakeSyncServer.writes, writes)
    }

    func testAWriteThatLosesARaceMergesAndTriesAgain() async throws {
        let key = SymmetricKey(size: .bits256)
        let first = device(key: key)
        first.memory.add("Prefers tea", kind: .preference)
        await first.engine.sync()

        // Between this iPhone reading and writing, another device writes memory.
        let other = SyncItems.WireFact(id: UUID().uuidString.lowercased(), text: "Wears a suit on Mondays", category: "preferences",
                                       updated: SyncItems.ms(Date()))
        let theirs = try SyncEngine.memoryPlaintext(first.memory.wireFacts + [other])
        FakeSyncServer.beforePut = { itemKey in
            guard itemKey == "memory" else { return }
            FakeSyncServer.beforePut = nil
            FakeSyncServer.store(key: "memory", data: try? SyncSeal.seal(theirs, key: key, itemKey: "memory"))
        }
        first.memory.add("Allergic to shellfish", kind: .fact)
        await first.engine.sync()
        XCTAssertEqual(first.engine.status, .idle)
        XCTAssertTrue(first.memory.facts.contains { $0.text == "Wears a suit on Mondays" })

        let second = device(key: key)
        await second.engine.sync()
        XCTAssertEqual(Set(second.memory.facts.map(\.text)), ["Prefers tea", "Wears a suit on Mondays", "Allergic to shellfish"])
    }

    func testTheWrongKeyChangesNothing() async {
        let first = device(key: SymmetricKey(size: .bits256))
        first.memory.add("Prefers tea", kind: .preference)
        await first.engine.sync()
        let writes = FakeSyncServer.writes

        let stranger = device(key: SymmetricKey(size: .bits256))
        stranger.memory.add("Something of its own")
        await stranger.engine.sync()
        XCTAssertEqual(stranger.engine.status, .wrongKey)
        XCTAssertEqual(stranger.memory.facts.map(\.text), ["Something of its own"])
        XCTAssertEqual(FakeSyncServer.writes, writes)  // and nothing of the account's was overwritten
    }

    func testAnIPhoneWithoutTheKeyWaitsForIt() async {
        let first = device(key: nil)  // the first to turn sync on makes the key
        first.memory.add("Prefers tea", kind: .preference)
        await first.engine.sync()
        XCTAssertEqual(first.engine.status, .idle)
        XCTAssertTrue(FakeSyncServer.keys.contains("keycheck"))

        let second = device(key: nil)
        await second.engine.sync()
        XCTAssertEqual(second.engine.status, .needsKey)
        XCTAssertTrue(second.memory.facts.isEmpty)
    }
}

/// askeden.com's sync endpoints, in memory.
final class FakeSyncServer: URLProtocol, @unchecked Sendable {
    private struct Item {
        var rev: Int
        var data: String?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var items: [String: Item] = [:]
    nonisolated(unsafe) private static var rev = 0
    nonisolated(unsafe) private static var writeCount = 0
    nonisolated(unsafe) private static var hook: ((String) -> Void)?

    /// Runs (once per set) before a PUT is handled: another device writing first.
    static var beforePut: ((String) -> Void)? {
        get { lock.withLock { hook } }
        set { lock.withLock { hook = newValue } }
    }

    static func reset() {
        lock.withLock {
            items = [:]
            rev = 0
            writeCount = 0
            hook = nil
        }
    }

    static var keys: [String] { lock.withLock { items.filter { $0.value.data != nil }.map(\.key) } }
    static var allData: [String] { lock.withLock { items.values.compactMap(\.data) } }
    static var writes: Int { lock.withLock { writeCount } }

    static func store(key: String, data: String?) {
        lock.withLock {
            rev += 1
            items[key] = Item(rev: rev, data: data)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "askeden.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let (status, body) = handle()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    private var requestBody: JSONValue? {
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
        return data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }

    private func handle() -> (Int, Data) {
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return (400, Data()) }
        let path = url.path.replacingOccurrences(of: "/api/", with: "")
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let method = request.httpMethod ?? "GET"
        if method == "PUT", path.hasPrefix("sync/") { Self.beforePut?(String(path.dropFirst(5))) }
        return Self.lock.withLock { () -> (Int, Data) in
            switch (method, path) {
            case ("GET", "sync"):
                let since = Int(query["since"] ?? "0") ?? 0
                let changed = Self.items.filter { $0.value.rev > since }.sorted { $0.value.rev < $1.value.rev }
                let list: [JSONValue] = changed.map { key, item in
                    ["key": .string(key), "rev": .int(item.rev), "data": item.data.map { .string($0) } ?? .null,
                     "deleted": .bool(item.data == nil), "updated": .int(Int(Date().timeIntervalSince1970 * 1000))]
                }
                return (200, try! JSONValue.object(["rev": .int(Self.rev), "items": .array(list), "more": false]).encoded())
            case ("DELETE", "sync"):
                Self.items = [:]
                return (204, Data())
            case ("PUT", _) where path.hasPrefix("sync/"):
                let key = String(path.dropFirst(5))
                let body = requestBody
                let base = body?["base_rev"]?.intValue ?? 0
                if let current = Self.items[key], current.rev != base {
                    let item: JSONValue = ["key": .string(key), "rev": .int(current.rev), "data": current.data.map { .string($0) } ?? .null]
                    return (409, try! JSONValue.object(["code": "conflict", "error": "Changed elsewhere.", "item": item]).encoded())
                }
                Self.rev += 1
                Self.writeCount += 1
                Self.items[key] = Item(rev: Self.rev, data: body?["data"]?.stringValue)
                return (200, try! JSONValue.object(["rev": .int(Self.rev)]).encoded())
            case ("DELETE", _) where path.hasPrefix("sync/"):
                let key = String(path.dropFirst(5))
                Self.rev += 1
                Self.writeCount += 1
                Self.items[key] = Item(rev: Self.rev, data: nil)
                return (200, try! JSONValue.object(["rev": .int(Self.rev)]).encoded())
            default:
                return (404, Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
            }
        }
    }
}
