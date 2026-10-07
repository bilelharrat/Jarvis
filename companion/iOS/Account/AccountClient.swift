import Foundation

/// What went wrong talking to askeden.com, in words for a person (docs/accounts.md:
/// `{"error": "<words>", "code": "<machine code>"}`).
enum AccountError: LocalizedError, Equatable {
    /// 401 `signed_out`: the token is unknown or was revoked. The app forgets it.
    case signedOut
    /// 402 `no_allowance`: the plan's allowance and the trial are both spent.
    case noAllowance(String?)
    case forbidden(String?)
    case notFound(String?)
    /// 404 `offline`: the Mac isn't connected right now.
    case offline
    /// 409 `conflict` (sync answers its own way; this is for the rest).
    case conflict(String?)
    /// 410: the link code expired, or was turned down.
    case expired(String?)
    case tooBig
    /// 429 `slow_down`.
    case slowDown(retryAfter: Int?)
    /// 503 `not_set_up`: askeden.com is missing a secret it needs.
    case notSetUp
    case rejected(String?)
    case network(String)
    case server(Int, String?)
    case malformed

    var errorDescription: String? {
        switch self {
        case .signedOut: "You’ve been signed out of your Jarvis account. Sign in again in Settings › Account."
        case .noAllowance(let words): words ?? "This month’s included AI is used up. Upgrade to Jarvis Plus for more."
        case .forbidden(let words): words ?? "Your account doesn’t allow that."
        case .notFound(let words): words ?? "That isn’t there anymore."
        case .offline: "Your Mac isn’t connected right now. Make sure it’s on and JARVIS is open."
        case .conflict(let words): words ?? "Something changed at the same time. Try again."
        case .expired(let words): words ?? "That code expired. Make a new one on your Mac."
        case .tooBig: "That’s more than your account can keep."
        case .slowDown: "Too many tries just now. Wait a minute and try again."
        case .notSetUp: "Jarvis accounts aren’t fully set up yet. Try again later."
        case .rejected(let words): words ?? "askeden.com didn’t accept that."
        case .network(let words): "Couldn’t reach askeden.com: \(words)"
        case .server(let status, let words): words ?? "askeden.com had a problem (\(status))."
        case .malformed: "askeden.com’s answer couldn’t be read."
        }
    }

    /// A status and body to the error they mean.
    static func from(status: Int, body: Data, retryAfter: String? = nil) -> AccountError {
        let json = try? JSONDecoder().decode(JSONValue.self, from: body)
        // Ours is {"error": "…", "code": "…"}; the Anthropic proxy's is Anthropic's shape.
        let words = json?["error"]?.stringValue?.trimmed.nilIfEmpty ?? json?["error"]?["message"]?.stringValue?.trimmed.nilIfEmpty
        let code = json?["code"]?.stringValue ?? json?["error"]?["type"]?.stringValue
        switch status {
        case 401: return .signedOut
        case 402: return .noAllowance(words)
        case 403: return .forbidden(words)
        case 404: return code == "offline" ? .offline : .notFound(words)
        case 409: return .conflict(words)
        case 410: return .expired(code == "denied" ? "The link was turned down." : words)
        case 413: return .tooBig
        case 429: return .slowDown(retryAfter: retryAfter.flatMap { Int($0.trimmed) })
        case 503: return code == "not_set_up" || code == nil ? .notSetUp : .server(status, words)
        case 400: return .rejected(words)
        default: return .server(status, words)
        }
    }
}

/// askeden.com's account API over HTTPS: JSON in and out, this device's bearer token.
struct AccountClient: Sendable {
    static let base = URL(string: "https://askeden.com/api")!

    var base: URL = AccountClient.base
    var token: String?
    var session: URLSession = .shared

    // MARK: - Signing in

    struct SignIn: Decodable, Sendable {
        var token: String
        var account: Account
        var deviceID: String
        var isNew: Bool

        private enum Key: String, CodingKey {
            case token, account
            case deviceID = "device_id", isNew = "new"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            token = try c.decode(String.self, forKey: .token)
            account = try c.decode(Account.self, forKey: .account)
            deviceID = c.text(.deviceID) ?? ""
            isNew = c.flag(.isNew) ?? false
        }
    }

    /// This device, as the account lists it.
    struct DeviceInfo: Sendable {
        var name: String
        var kind = "iphone"
        var appVersion: String

        var json: JSONValue { ["name": .string(name), "kind": .string(kind), "app_version": .string(appVersion)] }
    }

    func signInWithApple(identityToken: String, nonce: String, authorizationCode: String?, device: DeviceInfo) async throws -> SignIn {
        let body = JSONValue.object(dropping: [
            "identity_token": .string(identityToken),
            "nonce": .string(nonce),
            "authorization_code": authorizationCode.map { .string($0) },
            "device": device.json,
        ])
        return try await decode(SignIn.self, call("POST", "account/apple", body: body, authorized: false))
    }

    // MARK: - The account

    func account() async throws -> Account {
        try await decode(Account.self, call("GET", "account"))
    }

    func deleteAccount() async throws {
        _ = try await call("DELETE", "account")
    }

    /// Any of name, app_version, apns_token (null stops pushes), apns_env.
    func updateThisDevice(_ fields: [String: JSONValue]) async throws {
        _ = try await call("PUT", "devices/me", body: .object(fields))
    }

    /// Signs a device out ("me" for this one).
    func removeDevice(_ id: String) async throws {
        _ = try await call("DELETE", "devices/\(id)")
    }

    /// The newest StoreKit transaction (its JWS); the account as it stands after.
    func sendTransaction(_ jws: String) async throws -> Account {
        try await decode(Account.self, call("POST", "subscription", body: ["signed_transaction": .string(jws)]))
    }

    // MARK: - Linking a Mac, approving a browser's sign-in

    struct LinkInfo: Decodable, Equatable, Sendable {
        var name: String
        var kind: String
        /// Base64 X25519, 32 bytes.
        var publicKey: String?
        var expiresIn: Int?

        init(name: String, kind: String = "mac", publicKey: String?, expiresIn: Int? = nil) {
            self.name = name
            self.kind = kind
            self.publicKey = publicKey
            self.expiresIn = expiresIn
        }

        private enum Key: String, CodingKey {
            case name, kind
            case publicKey = "public_key", expiresIn = "expires_in"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            kind = c.text(.kind) ?? "mac"
            name = c.text(.name)?.trimmed.nilIfEmpty ?? (kind == "web" ? "Eden on the web" : "your Mac")
            publicKey = c.text(.publicKey)
            expiresIn = c.integer(.expiresIn)
        }

        /// A browser signing in to Eden at askeden.com, not a Mac joining the account.
        var isWeb: Bool { kind == "web" }
    }

    struct Linked: Decodable, Equatable, Sendable {
        var deviceID: String
        var name: String?

        private enum Key: String, CodingKey { case name, deviceID = "device_id" }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            deviceID = c.text(.deviceID) ?? ""
            name = c.text(.name)
        }
    }

    func linkInfo(code: String) async throws -> LinkInfo {
        try await decode(LinkInfo.self, call("GET", "link/\(code)"))
    }

    func approveLink(code: String, sealedKey: String?, senderKey: String?) async throws -> Linked {
        let body: JSONValue = [
            "sealed_key": sealedKey.map { .string($0) } ?? .null,
            "sender_key": senderKey.map { .string($0) } ?? .null,
        ]
        return try await decode(Linked.self, call("POST", "link/\(code)/approve", body: body))
    }

    func denyLink(code: String) async throws {
        _ = try await call("POST", "link/\(code)/deny", body: [:])
    }

    // MARK: - Sync

    struct SyncItem: Decodable, Equatable, Sendable {
        var key: String
        var rev: Int
        var data: String?
        var deleted: Bool
        var updated: Date?

        init(key: String, rev: Int, data: String?, deleted: Bool = false, updated: Date? = nil) {
            self.key = key
            self.rev = rev
            self.data = data
            self.deleted = deleted
            self.updated = updated
        }

        private enum Key: String, CodingKey { case key, rev, data, deleted, updated }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            key = c.text(.key) ?? ""
            rev = c.integer(.rev) ?? 0
            data = c.text(.data)
            deleted = c.flag(.deleted) ?? (data == nil)
            updated = c.date(.updated)
        }
    }

    struct SyncPage: Decodable, Sendable {
        var rev: Int
        var items: [SyncItem]
        var more: Bool

        private enum Key: String, CodingKey { case rev, items, more }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            rev = c.integer(.rev) ?? 0
            items = c.list(SyncItem.self, .items).filter { !$0.key.isEmpty }
            more = c.flag(.more) ?? false
        }
    }

    enum PutResult: Equatable, Sendable {
        case saved(rev: Int)
        /// Someone else wrote it first: merge with theirs and try again.
        case conflict(SyncItem)
    }

    func syncChanges(since rev: Int) async throws -> SyncPage {
        try await decode(SyncPage.self, call("GET", "sync", query: [URLQueryItem(name: "since", value: String(rev))]))
    }

    func putSyncItem(key: String, data: String, baseRev: Int) async throws -> PutResult {
        let reply = try await call("PUT", "sync/\(key)", body: ["data": .string(data), "base_rev": .int(baseRev)], conflictBody: true)
        let json = try? JSONDecoder().decode(JSONValue.self, from: reply.data)
        if reply.status == 409 {
            guard let item = json?["item"], let raw = try? JSONEncoder().encode(item),
                  let theirs = try? JSONDecoder().decode(SyncItem.self, from: raw) else { throw AccountError.malformed }
            return .conflict(theirs)
        }
        guard let rev = json?["rev"]?.intValue else { throw AccountError.malformed }
        return .saved(rev: rev)
    }

    func deleteSyncItem(key: String, baseRev: Int) async throws -> Int {
        let reply = try await call("DELETE", "sync/\(key)", query: [URLQueryItem(name: "base_rev", value: String(baseRev))])
        return (try? JSONDecoder().decode(JSONValue.self, from: reply.data))?["rev"]?.intValue ?? 0
    }

    func deleteAllSync() async throws {
        _ = try await call("DELETE", "sync")
    }

    // MARK: - Eden's tasks

    /// One of Eden's task approvals as askeden.com tells it after a decision.
    struct TaskApproval: Decodable, Equatable, Sendable {
        var id: String
        /// "approved", "denied", or "failed" (approved, but doing it went wrong: see `error`).
        var status: String
        /// What approving did, in words ("Sent to …").
        var result: String?
        var error: String?
        var taskTitle: String?

        init(id: String, status: String, result: String? = nil, error: String? = nil, taskTitle: String? = nil) {
            self.id = id
            self.status = status
            self.result = result
            self.error = error
            self.taskTitle = taskTitle
        }

        private enum Key: String, CodingKey {
            case id, status, result, error
            case taskTitle = "task_title"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            id = c.text(.id) ?? ""
            status = c.text(.status) ?? ""
            result = c.text(.result)
            error = c.text(.error)
            taskTitle = c.text(.taskTitle)
        }

        var didFail: Bool { status == "failed" }
    }

    private struct DecidedApproval: Decodable {
        var approval: TaskApproval
    }

    /// Approves or denies one of Eden's task approvals (Approve / Deny on its notification).
    /// Approving does the thing (sends the draft, adds the event) before answering.
    func decideTaskApproval(id: String, approve: Bool) async throws -> TaskApproval {
        guard EdenTaskPush.isID(id) else { throw AccountError.notFound("That approval is gone.") }
        let body: JSONValue = ["decision": .string(approve ? "approve" : "deny")]
        return try await decode(DecidedApproval.self, call("POST", "tasks/approvals/\(id)", body: body)).approval
    }

    // MARK: - Plumbing

    struct Reply: Sendable {
        var status: Int
        var data: Data
    }

    func call(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: JSONValue? = nil,
        authorized: Bool = true, conflictBody: Bool = false
    ) async throws -> Reply {
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw AccountError.malformed }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try body.encoded()
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized {
            guard let token else { throw AccountError.signedOut }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw AccountError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw AccountError.malformed }
        if (200..<300).contains(http.statusCode) || (conflictBody && http.statusCode == 409) {
            return Reply(status: http.statusCode, data: data)
        }
        throw AccountError.from(status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "retry-after"))
    }

    func decode<T: Decodable>(_ type: T.Type, _ reply: Reply) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: reply.data)
        } catch {
            throw AccountError.malformed
        }
    }
}
