import Foundation

/// What went wrong talking to the Mac, in words for the screen.
enum JarvisError: LocalizedError, Equatable {
    /// No connection: wrong address, Mac asleep, "Let my phone connect" off, other network.
    /// The request never reached the Mac, so it's safe to send again later.
    case unreachable(String)
    /// The connection dropped mid-request: the Mac may or may not have it.
    case connectionLost
    /// 401: the token is missing, or the device was removed on the Mac.
    case unpaired
    /// 403 while pairing: wrong or expired code, or locked out after five tries.
    case wrongCode(String)
    /// 400 (or 403, 409 outside pairing): the Mac refused the request.
    case rejected(String)
    /// 503: e.g. JARVIS's voice isn't available right now.
    case unavailable
    /// 429: one request at a time, or too many lately.
    case busy(String)
    /// 413: bigger than the Mac takes.
    case tooBig
    /// The request took longer than we wait; the Mac may still be working on it.
    case timedOut
    /// Something answered, but not the Jarvis companion API.
    case notJarvis
    /// 404 on a newer endpoint: the Mac's Jarvis doesn't have it yet.
    case unsupported
    /// 404 with the Mac's reason ("no such session"): what it was about isn't on the Mac
    /// anymore (closed, finished or deleted there).
    case gone(String)
    case server(Int, String?)
    case invalidAddress
    /// The server presented a certificate other than the one pinned for this Mac.
    case certificateMismatch
    /// 409 while pairing: the Mac's certificate isn't the one this device pinned.
    case fingerprintRefused
    /// No encrypted connection could be made (an older Jarvis, or not Jarvis at all).
    case notEncrypted
    /// There's no pinned certificate to talk to the Mac with: pair again.
    case notPinned

    var title: String {
        switch self {
        case .unreachable: "Can’t reach the Mac"
        case .connectionLost: "The connection dropped"
        case .unpaired: "Not paired"
        case .wrongCode(let message): message.localizedCaseInsensitiveContains("too many") ? "Too many tries" : "Wrong code"
        case .rejected: "The Mac said no"
        case .unavailable: "Not available right now"
        case .busy: "Jarvis is busy"
        case .tooBig: "Too big to send"
        case .timedOut: "Still working"
        case .notJarvis: "That isn’t Jarvis"
        case .unsupported: "Not on this Mac yet"
        case .gone: "Not on your Mac anymore"
        case .server: "The Mac had a problem"
        case .invalidAddress: "Check the address"
        case .certificateMismatch: "This isn’t your Mac"
        case .fingerprintRefused: "Fingerprints don’t match"
        case .notEncrypted: "No secure connection"
        case .notPinned: "Pair again"
        }
    }

    var message: String {
        switch self {
        case .unreachable:
            "Is ‘Let my phone connect’ on in Jarvis Settings? Your iPhone and Mac need the same Wi‑Fi, or Tailscale on both."
        case .connectionLost:
            "Your Mac may still have got it. The conversation will show it if it did."
        case .unpaired:
            "Jarvis on your Mac doesn’t know this device anymore. Pair it again."
        case .wrongCode(let message):
            message.isEmpty ? "That code isn’t right, or it expired. Make a new one on the Mac." : message
        case .rejected(let message):
            message
        case .unavailable:
            "Jarvis can’t do that right now."
        case .busy(let message):
            message.isEmpty ? "Try again in a moment." : message
        case .tooBig:
            "Your Mac takes files up to 18 MB from here."
        case .timedOut:
            "Jarvis is taking a while. The reply will show up here when it’s ready."
        case .notJarvis:
            "Something answered at that address, but it isn’t the Jarvis companion. Check the address and port (usually 8765)."
        case .unsupported:
            "Update Jarvis on your Mac to use this from your iPhone."
        case .gone:
            "It may have been closed or deleted there."
        case .server(let status, let message):
            message ?? "HTTP \(status)"
        case .invalidAddress:
            "Enter the Mac’s address, like 192.168.1.20 or my-mac.local. The port is 8765 unless you changed it."
        case .certificateMismatch:
            "The Mac at this address has a different certificate than the one this iPhone trusts. If you reset it on the Mac, pair again. Otherwise something may be in between: don’t pair on this network."
        case .fingerprintRefused:
            "Your Mac’s certificate isn’t the one this iPhone saw, so something may be in between. Pair again on your home network."
        case .notEncrypted:
            "Couldn’t set up an encrypted connection. Make sure Jarvis on your Mac is up to date."
        case .notPinned:
            "Jarvis on your Mac now encrypts the connection. Pair again to trust it."
        }
    }

    var errorDescription: String? {
        switch self {
        case .unreachable: "Can’t reach the Mac — is ‘Let my phone connect’ on in Jarvis Settings?"
        default: "\(title). \(message)"
        }
    }

    /// The request never got to the Mac: it can go again later without doing anything twice.
    var neverDelivered: Bool {
        if case .unreachable = self { return true }
        return false
    }
}

/// The Mac's companion API (jarvis.remote): HTTPS to a pinned self-signed certificate,
/// bearer token, JSON.
struct JarvisAPI: Sendable {
    let baseURL: URL
    var token: String?
    /// The pinned certificate's fingerprint. Without one nothing is sent.
    var fingerprint: String?

    init(baseURL: URL, token: String?, fingerprint: String?) {
        self.baseURL = baseURL
        self.token = token
        self.fingerprint = fingerprint
    }

    // MARK: - Pairing

    /// Trust on first use: connect, read the certificate the Mac presents, and hang up
    /// before sending anything. Returns its fingerprint for the person to compare.
    static func probeFingerprint(at baseURL: URL) async throws -> String {
        guard baseURL.scheme == "https" else { throw JarvisError.notEncrypted }
        var request = URLRequest(url: baseURL.appending(path: "api/state"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let delegate = ServerTrustDelegate(.capture)
        let session = PinnedSessions.probeSession()
        defer { session.finishTasksAndInvalidate() }
        do {
            _ = try await session.data(for: request, delegate: delegate)
        } catch let error as URLError {
            if let presented = delegate.presented { return presented }
            throw Self.map(error, delegate: nil)
        } catch {
            if let presented = delegate.presented { return presented }
            throw JarvisError.unreachable(error.localizedDescription)
        }
        // An answer without a certificate challenge can't be TLS to a self-signed server.
        throw JarvisError.notEncrypted
    }

    /// Trade the Mac's six-digit code for this device's own token, over the pinned
    /// connection. The Mac refuses (409) when the pinned fingerprint isn't its own.
    func pair(code: String, deviceName: String) async throws -> PairResult {
        guard let fingerprint else { throw JarvisError.notPinned }
        let body: JSONValue = [
            "code": .string(code),
            "device_name": .string(deviceName),
            "name": .string(deviceName),  // what Macs from before TLS read
            "fingerprint": .string(fingerprint),
        ]
        let data = try await send("api/pair", body: try body.encoded(), timeout: 12, authorized: false, pairing: true)
        guard let result = try? JSONDecoder().decode(PairResult.self, from: data) else { throw JarvisError.notJarvis }
        if let echoed = result.fingerprint, echoed != CertificatePin.normalize(fingerprint) {
            throw JarvisError.fingerprintRefused
        }
        return result
    }

    // MARK: - State and conversation

    func state() async throws -> RemoteState {
        let data: Data
        do {
            data = try await send("api/state", timeout: 8)
        } catch JarvisError.timedOut {
            throw JarvisError.unreachable("The Mac didn’t answer in time.")
        } catch JarvisError.unsupported {
            throw JarvisError.notJarvis  // every Jarvis has this one
        }
        return try decode(RemoteState.self, from: data)
    }

    /// Returns when the reply is done, or early when the request needs a yes. The Mac waits
    /// up to two minutes for a reply, so by default this waits a little longer.
    func ask(_ text: String, timeout: TimeInterval = 135) async throws -> AskResult {
        let data = try await post("api/ask", ["text": .string(text)], timeout: timeout)
        return try decode(AskResult.self, from: data)
    }

    /// False when the question was already answered (or timed out) on the Mac. A "no" can
    /// carry what to do instead (at most 2,000 characters).
    func approve(id: String, choice: String, feedback: String? = nil, timeout: TimeInterval = 10) async throws -> Bool {
        let reason = feedback.map { String($0.trimmed.prefix(2000)) }.flatMap { $0.isEmpty ? nil : $0 }
        let body = JSONValue.object(dropping: ["id": .string(id), "choice": .string(choice), "feedback": reason.map { .string($0) }])
        return try okay(await post("api/approve", body, timeout: timeout))
    }

    func command(_ command: MacCommand) async throws {
        _ = try await post("api/command", command.json, timeout: 15)
    }

    /// The text in JARVIS's own voice, as WAV. Throws `.unavailable` when the Mac can't speak.
    func say(_ text: String) async throws -> Data {
        try await post("api/say", ["text": .string(text)], timeout: 45)
    }

    // MARK: - Push and Live Activities

    func registerPush(token: String, environment: String, bundleID: String) async throws {
        _ = try await post("api/push/register", [
            "token": .string(token), "environment": .string(environment), "bundle_id": .string(bundleID),
        ], timeout: 10)
    }

    func unregisterPush() async throws {
        _ = try await post("api/push/unregister", [:], timeout: 6)
    }

    /// `activity` is "<kind>:<id>" (code, delegation, call, video). The environment and bundle
    /// id say which APNs the token belongs to (sandbox for Debug builds).
    func registerLiveActivity(_ activity: String, token: String, environment: String, bundleID: String) async throws {
        _ = try await post("api/live/register", [
            "activity": .string(activity), "token": .string(token),
            "environment": .string(environment), "bundle_id": .string(bundleID),
        ], timeout: 10)
    }

    // MARK: - Jarvis Code

    func codeSessions() async throws -> [CodeSession] {
        try decode(CodeSessionList.self, from: await send("api/code/sessions", timeout: 10)).sessions
    }

    /// Up to 200 entries after `after`; without it, the transcript's tail.
    func codeSession(id: Int, after: Int? = nil) async throws -> CodeSessionDetail {
        var query = [URLQueryItem(name: "id", value: String(id))]
        if let after { query.append(URLQueryItem(name: "after", value: String(after))) }
        return try decode(CodeSessionDetail.self, from: await send("api/code/session", query: query, timeout: 10))
    }

    func codeDiff(id: Int) async throws -> CodeDiff {
        try decode(CodeDiff.self, from: await send("api/code/diff", query: [URLQueryItem(name: "id", value: String(id))], timeout: 15))
    }

    /// Queued like the composer on the Mac does.
    func codeSend(id: Int, text: String) async throws -> Bool {
        try okay(await post("api/code/send", ["id": .int(id), "text": .string(text)], timeout: 10))
    }

    /// Interrupts the current step.
    func codeStop(id: Int) async throws -> Bool {
        try okay(await post("api/code/stop", ["id": .int(id)], timeout: 10))
    }

    // MARK: - Everything else

    func digest() async throws -> Digest {
        try decode(Digest.self, from: await send("api/digest", timeout: 15))
    }

    func delegations() async throws -> [DelegationItem] {
        try decode(DelegationList.self, from: await send("api/delegations", timeout: 10)).items
    }

    func stopDelegation(id: String) async throws -> Bool {
        try okay(await post("api/delegations/stop", ["id": .string(id)], timeout: 10))
    }

    func spending() async throws -> Spending {
        try decode(Spending.self, from: await send("api/spending", timeout: 10))
    }

    func routines() async throws -> [RoutineItem] {
        try decode(RoutineList.self, from: await send("api/routines", timeout: 10)).items
    }

    func updateRoutine(id: String, enabled: Bool? = nil, time: String? = nil, days: [Int]? = nil) async throws -> Bool {
        let body = JSONValue.object(dropping: [
            "id": .string(id),
            "enabled": enabled.map { .bool($0) },
            "time": time.map { .string($0) },
            "days": days.map { .array($0.map { .int($0) }) },
        ])
        return try okay(await post("api/routines/update", body, timeout: 10))
    }

    func runRoutine(id: String) async throws -> Bool {
        try okay(await post("api/routines/run", ["id": .string(id)], timeout: 10))
    }

    func deleteRoutine(id: String) async throws -> Bool {
        try okay(await post("api/routines/delete", ["id": .string(id)], timeout: 10))
    }

    func sendLocation(_ report: LocationReport) async throws {
        _ = try await post("api/location", report.body, timeout: 10)
    }

    func sendHealth(_ day: HealthDay) async throws {
        _ = try await post("api/health", day.body, timeout: 10)
    }

    /// What the Mac did with it: the name a file or image was saved as, and whether it
    /// took the note ("summarize this") as a request.
    func share(_ item: ShareItem) async throws -> ShareResult {
        if let data = item.data, data.count > ShareItem.maxBytes { throw JarvisError.tooBig }
        let data = try await send("api/share", body: try item.body(), timeout: 90)
        return (try? JSONDecoder().decode(ShareResult.self, from: data)) ?? ShareResult(savedAs: nil, asked: false)
    }

    /// A photo (JPEG, at most 8 MB) and an optional question: `{reply, done, approvals}`, done
    /// false while the Mac is still on it, with any cards it raised.
    func photo(jpeg: Data, question: String?) async throws -> AskResult {
        let question = question?.trimmed ?? ""
        var body = try JSONValue.object(dropping: ["question": question.isEmpty ? nil : .string(question)]).encoded()
        body.removeLast()  // {…} → {…,"data_base64":"…"}
        body.append(Data((body.count > 1 ? "," : "").utf8))
        body.append(Data(#""data_base64":""#.utf8))
        body.append(jpeg.base64EncodedData())
        body.append(Data(#""}"#.utf8))
        let data = try await send("api/photo", body: body, timeout: 120)
        return try decode(AskResult.self, from: data)
    }

    /// Any POST, for requests kept in the outbox.
    func post(_ path: String, _ body: JSONValue, timeout: TimeInterval) async throws -> Data {
        try await send(path, body: try body.encoded(), timeout: timeout)
    }

    /// A POST with its body already encoded (a share with its data spliced in).
    func send(raw path: String, body: Data, timeout: TimeInterval) async throws -> Data {
        try await send(path, body: body, timeout: timeout)
    }

    // MARK: - Plumbing

    private func send(
        _ path: String, query: [URLQueryItem] = [], body: Data? = nil, timeout: TimeInterval,
        authorized: Bool = true, pairing: Bool = false
    ) async throws -> Data {
        guard baseURL.scheme == "https" else { throw JarvisError.notPinned }
        guard let fingerprint = fingerprint.flatMap(CertificatePin.normalize) else { throw JarvisError.notPinned }
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw JarvisError.invalidAddress }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let delegate = ServerTrustDelegate(.pin(fingerprint))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await PinnedSessions.session(for: fingerprint).data(for: request, delegate: delegate)
        } catch let error as URLError {
            throw Self.map(error, delegate: delegate)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw JarvisError.unreachable(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw JarvisError.notJarvis }
        return try Self.check(status: http.statusCode, data: data, pairing: pairing)
    }

    /// A status code and body to data, or the error it means.
    static func check(status: Int, data: Data, pairing: Bool = false) throws -> Data {
        let message = Self.message(in: data)
        switch status {
        case 200..<300: return data
        case 401: throw JarvisError.unpaired
        case 403: throw pairing ? JarvisError.wrongCode(message ?? "") : JarvisError.rejected(message ?? "The Mac didn’t allow that.")
        case 400: throw JarvisError.rejected(message ?? "The Mac didn’t accept that.")
        case 404:
            // The Mac says why when it's the thing asked about that's missing; an endpoint it
            // doesn't have yet answers without a reason.
            if pairing { throw JarvisError.notJarvis }
            throw message.map { JarvisError.gone($0) } ?? JarvisError.unsupported
        case 409: throw pairing && message == "fingerprint" ? JarvisError.fingerprintRefused : JarvisError.rejected(message ?? "The Mac didn’t accept that.")
        case 413: throw JarvisError.tooBig
        case 429: throw JarvisError.busy(message ?? "")
        case 503: throw JarvisError.unavailable
        default: throw JarvisError.server(status, message)
        }
    }

    /// URLSession's errors in the app's words. A refused certificate shows up as a
    /// cancelled task; the delegate knows it was that.
    static func map(_ error: URLError, delegate: ServerTrustDelegate?) -> Error {
        switch error.code {
        case .cancelled:
            if delegate?.rejected == true { return JarvisError.certificateMismatch }
            return CancellationError()
        case .timedOut:
            return JarvisError.timedOut
        case .networkConnectionLost, .badServerResponse, .cannotParseResponse, .zeroByteResource:
            return JarvisError.connectionLost
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected,
             .clientCertificateRequired:
            if delegate?.rejected == true { return JarvisError.certificateMismatch }
            return JarvisError.notEncrypted
        case .appTransportSecurityRequiresSecureConnection:
            return JarvisError.notEncrypted
        default:
            return JarvisError.unreachable(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw JarvisError.notJarvis
        }
    }

    /// `{ok}` bodies: true unless the Mac says false.
    private func okay(_ data: Data) -> Bool {
        (try? JSONDecoder().decode(OkBody.self, from: data))?.ok ?? true
    }

    private static func message(in data: Data) -> String? {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
    }
}

private struct OkBody: Decodable { var ok: Bool? }
private struct ErrorBody: Decodable { var error: String? }

/// POST /api/share: `{ok, saved_as?, asked}`.
struct ShareResult: Equatable, Sendable, Decodable {
    var savedAs: String?
    /// The note went to Jarvis as a request.
    var asked: Bool

    init(savedAs: String?, asked: Bool) {
        self.savedAs = savedAs
        self.asked = asked
    }

    private enum Key: String, CodingKey {
        case asked
        case savedAs = "saved_as"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        savedAs = c.text(.savedAs).flatMap { $0.trimmed.isEmpty ? nil : $0 }
        asked = c.flag(.asked) ?? false
    }
}
