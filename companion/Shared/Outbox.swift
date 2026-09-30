import Foundation

/// Requests made while the Mac can't be reached, kept until it's back (at most an hour),
/// then sent in the order they were made. It lives in the App Group container, so the share
/// extension and Siri add to the same queue the app sends from.
///
/// Only requests that still mean something later go in: questions, the briefing, a
/// routine, a share, a message to a Jarvis Code session, location and health. Stop,
/// meeting notes and approvals are about this moment, and fail plainly instead.
struct OutboxItem: Codable, Identifiable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case ask, command, share, location, health, codeSend
    }

    var id: UUID
    var kind: Kind
    /// The API path, e.g. "api/ask".
    var path: String
    /// The JSON body; a share's data waits in a file beside the queue instead.
    var body: JSONValue
    /// A file in the outbox folder holding a share's data.
    var payloadFile: String?
    var createdAt: Date
    /// What it is, for the list of things waiting ("Ask: What's the weather?").
    var label: String
    /// A newer item with the same key replaces an older one (the latest location fix).
    var coalesceKey: String?
    var attempts: Int = 0

    static let lifetime: TimeInterval = 60 * 60

    func expires(at now: Date) -> Bool { now.timeIntervalSince(createdAt) >= Self.lifetime }

    var expiresAt: Date { createdAt.addingTimeInterval(Self.lifetime) }

    /// The question, for an ask.
    var question: String? { kind == .ask ? body["text"]?.stringValue : nil }
}

extension OutboxItem {
    static func ask(_ text: String, at now: Date = Date()) -> OutboxItem {
        OutboxItem(id: UUID(), kind: .ask, path: "api/ask", body: ["text": .string(text)], createdAt: now, label: text)
    }

    static func command(_ command: MacCommand, label: String, at now: Date = Date()) -> OutboxItem {
        OutboxItem(id: UUID(), kind: .command, path: "api/command", body: command.json, createdAt: now, label: label)
    }

    static func codeSend(session: Int, text: String, title: String, at now: Date = Date()) -> OutboxItem {
        OutboxItem(
            id: UUID(), kind: .codeSend, path: "api/code/send", body: ["id": .int(session), "text": .string(text)],
            createdAt: now, label: "\(title): \(text)"
        )
    }

    static func location(_ report: LocationReport, at now: Date = Date()) -> OutboxItem {
        // Arriving and leaving are events worth keeping each; a plain fix only matters as the latest.
        let key = report.event == nil ? "location" : nil
        let label: String
        switch (report.event, report.region) {
        case (.arrive?, let region?): label = "Arrived \(region == .home ? "home" : "at work")"
        case (.leave?, let region?): label = "Left \(region == .home ? "home" : "work")"
        default: label = "Your location"
        }
        return OutboxItem(id: UUID(), kind: .location, path: "api/location", body: report.body, createdAt: now, label: label, coalesceKey: key)
    }

    static func health(_ day: HealthDay, at now: Date = Date()) -> OutboxItem {
        OutboxItem(
            id: UUID(), kind: .health, path: "api/health", body: day.body, createdAt: now,
            label: "Health summary for \(day.day)", coalesceKey: "health:\(day.day)"
        )
    }

    /// A share's small fields; its data is stored separately (see `Outbox.add(_:payload:)`).
    static func share(_ item: ShareItem, at now: Date = Date()) -> OutboxItem {
        let label: String
        switch item.kind {
        case .url: label = item.url ?? "A link"
        case .text: label = String((item.text ?? "Some text").prefix(60))
        case .image: label = item.name ?? "A photo"
        case .file: label = item.name ?? "A file"
        }
        return OutboxItem(id: UUID(), kind: .share, path: "api/share", body: item.fields, createdAt: now, label: "Shared: \(label)")
    }
}

/// The queue on disk: `outbox.json`, and share payloads beside it. Every read-modify-write
/// is coordinated, so the app and its extensions can use it at once.
final class Outbox: @unchecked Sendable {
    let directory: URL
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var draining = false

    /// The shared queue in the App Group container.
    static let shared = Outbox(directory: AppGroup.directory.appending(path: "Outbox", directoryHint: .isDirectory))

    init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    private var file: URL { directory.appending(path: "outbox.json") }

    /// What's waiting, oldest first, without anything expired.
    func items() -> [OutboxItem] {
        let now = now()
        return read().filter { !$0.expires(at: now) }
    }

    /// Adds a request (replacing an older one with the same key). A share's data goes in a
    /// file of its own.
    func add(_ item: OutboxItem, payload: Data? = nil) throws {
        var item = item
        if let payload {
            let name = "\(item.id.uuidString).payload"
            try ensureDirectory()
            try payload.write(to: directory.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            item.payloadFile = name
        }
        try update { items in
            if let key = item.coalesceKey {
                items.removeAll { $0.coalesceKey == key }
            }
            items.append(item)
        }
    }

    func remove(_ id: UUID) {
        try? update { items in items.removeAll { $0.id == id } }
    }

    /// Runs `body` unless another drain of this queue is under way in this process (the
    /// app's own and background refresh's can start together): nil then, so nothing waiting
    /// is sent twice. The app is the only process that sends from the queue; Siri and the
    /// share sheet only add to it.
    func exclusively<T>(_ body: () async -> T) async -> T? {
        let mine: Bool = lock.withLock {
            guard !draining else { return false }
            draining = true
            return true
        }
        guard mine else { return nil }
        defer { lock.withLock { draining = false } }
        return await body()
    }

    func removeAll() {
        try? update { items in items.removeAll() }
    }

    func noteAttempt(_ id: UUID) {
        try? update { items in
            if let index = items.firstIndex(where: { $0.id == id }) { items[index].attempts += 1 }
        }
    }

    /// Drops what has waited an hour; returns how many went.
    @discardableResult
    func pruneExpired() -> Int {
        var dropped = 0
        let now = now()
        try? update { items in
            let before = items.count
            items.removeAll { $0.expires(at: now) }
            dropped = before - items.count
        }
        return dropped
    }

    /// The whole request body, with a share's data spliced back in.
    func body(for item: OutboxItem) throws -> Data {
        guard let name = item.payloadFile else { return try item.body.encoded() }
        let data = try Data(contentsOf: directory.appending(path: name))
        var json = try item.body.encoded()
        json.removeLast()
        json.append(Data(#","data_base64":""#.utf8))
        json.append(data.base64EncodedData())
        json.append(Data(#""}"#.utf8))
        return json
    }

    // MARK: - Disk

    private func read() -> [OutboxItem] {
        var result: [OutboxItem] = []
        coordinate(writing: false) { url in
            result = Self.decode(url)
        }
        return result
    }

    private func update(_ change: (inout [OutboxItem]) -> Void) throws {
        try ensureDirectory()
        var failure: Error?
        coordinate(writing: true) { url in
            var items = Self.decode(url)
            let before = Set(items.compactMap(\.payloadFile))
            change(&items)
            let after = Set(items.compactMap(\.payloadFile))
            do {
                let data = try JSONEncoder().encode(items)
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                for gone in before.subtracting(after) {
                    try? FileManager.default.removeItem(at: directory.appending(path: gone))
                }
            } catch {
                failure = error
            }
        }
        if let failure { throw failure }
    }

    /// A damaged or hand-edited file reads as an empty queue, never a crash.
    private static func decode(_ url: URL) -> [OutboxItem] {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return [] }
        if let items = try? JSONDecoder().decode([OutboxItem].self, from: data) { return items }
        // Keep what still reads.
        guard let raw = try? JSONDecoder().decode([JSONValue].self, from: data) else { return [] }
        return raw.compactMap { value in
            (try? value.encoded()).flatMap { try? JSONDecoder().decode(OutboxItem.self, from: $0) }
        }
    }

    private func coordinate(writing: Bool, _ body: (URL) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var error: NSError?
        if writing {
            coordinator.coordinate(writingItemAt: file, options: .forMerging, error: &error) { body($0) }
        } else {
            coordinator.coordinate(readingItemAt: file, options: [], error: &error) { body($0) }
        }
        if error != nil { body(file) }  // coordination unavailable: still do it, under the lock
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
}

/// Sends what's waiting, oldest first, when the Mac can be reached again.
enum OutboxSender {
    struct Report: Equatable, Sendable {
        var sent: [OutboxItem] = []
        /// The Mac refused them (they'd never go through): dropped.
        var refused: [OutboxItem] = []
        var expired = 0
        /// Still waiting: the Mac went away again, or was busy.
        var remaining = 0
        /// Replies to questions that came back while sending.
        var replies: [String: String] = [:]
    }

    /// How one request went.
    enum Outcome: Equatable, Sendable {
        /// The Mac has it (a question that timed out waiting for its reply counts: the Mac
        /// carries on with it, and sending it again would ask twice).
        case delivered(reply: String?)
        /// The Mac said no: sending it again won't help.
        case refused
        /// Try again later, and stop sending the rest now.
        case unreachable
        /// Try this one again later (the Mac is busy with a question), carry on with others.
        case later
    }

    typealias Send = @Sendable (OutboxItem, Data) async -> Outcome

    /// Sends through a pinned API.
    static func sender(for api: JarvisAPI, askTimeout: TimeInterval = 20) -> Send {
        { item, body in
            await outcome {
                if item.kind == .ask {
                    let data = try await api.post(item.path, try JSONDecoder().decode(JSONValue.self, from: body), timeout: askTimeout)
                    let result = try? JSONDecoder().decode(AskResult.self, from: data)
                    return result?.done == true ? result?.reply : nil
                }
                _ = try await api.send(raw: item.path, body: body, timeout: item.kind == .share ? 90 : 15)
                return nil
            }
        }
    }

    static func outcome(_ attempt: () async throws -> String?) async -> Outcome {
        do {
            return .delivered(reply: try await attempt())
        } catch let error as JarvisError {
            switch error {
            case .unreachable, .notPinned, .certificateMismatch, .notEncrypted: return .unreachable
            case .timedOut, .connectionLost: return .delivered(reply: nil)
            case .busy: return .later
            case .unpaired: return .unreachable  // kept: pairing again sends it
            default: return .refused
            }
        } catch is CancellationError {
            return .unreachable
        } catch {
            return .unreachable
        }
    }

    /// One pass over the queue, oldest first, unless another is already under way (see
    /// `Outbox.exclusively`).
    static func drain(_ outbox: Outbox, send: Send) async -> Report {
        await outbox.exclusively { await pass(outbox, send: send) } ?? Report(remaining: outbox.items().count)
    }

    /// One pass, for a caller already draining the queue. The Mac answers one question per
    /// device at a time, so a question it's still working on waits (busy) for a later pass,
    /// and so do the questions after it, which would otherwise get ahead of it; the rest go on.
    static func pass(_ outbox: Outbox, send: Send) async -> Report {
        var report = Report()
        var questionWaiting = false
        report.expired = outbox.pruneExpired()
        for item in outbox.items() {
            if Task.isCancelled { break }
            if item.kind == .ask, questionWaiting { continue }
            let body: Data
            do {
                body = try outbox.body(for: item)
            } catch {
                outbox.remove(item.id)  // its data is gone: nothing to send
                report.refused.append(item)
                continue
            }
            outbox.noteAttempt(item.id)
            switch await send(item, body) {
            case .delivered(let reply):
                outbox.remove(item.id)
                report.sent.append(item)
                if let reply { report.replies[item.id.uuidString] = reply }
            case .refused:
                outbox.remove(item.id)
                report.refused.append(item)
            case .unreachable:
                report.remaining = outbox.items().count
                return report
            case .later:
                if item.kind == .ask { questionWaiting = true }
                continue
            }
        }
        report.remaining = outbox.items().count
        return report
    }
}
