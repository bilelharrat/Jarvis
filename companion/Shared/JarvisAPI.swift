import Foundation

/// What went wrong talking to the Mac, in words for the screen.
enum JarvisError: LocalizedError, Equatable {
    /// No connection: wrong address, Mac asleep, "Let my phone connect" off, other network.
    case unreachable(String)
    /// 401: the token is missing, or the device was removed on the Mac.
    case unpaired
    /// 403 while pairing: wrong or expired code, or locked out after five tries.
    case wrongCode(String)
    /// 400: the Mac refused the request.
    case rejected(String)
    /// 503: e.g. JARVIS's voice isn't available right now.
    case unavailable
    /// The request took longer than we wait; the Mac may still be working on it.
    case timedOut
    /// Something answered, but not the Jarvis companion API.
    case notJarvis
    case server(Int, String?)
    case invalidAddress

    var title: String {
        switch self {
        case .unreachable: "Can’t reach the Mac"
        case .unpaired: "Not paired"
        case .wrongCode(let message): message.localizedCaseInsensitiveContains("too many") ? "Too many tries" : "Wrong code"
        case .rejected: "The Mac said no"
        case .unavailable: "Not available right now"
        case .timedOut: "Still working"
        case .notJarvis: "That isn’t Jarvis"
        case .server: "The Mac had a problem"
        case .invalidAddress: "Check the address"
        }
    }

    var message: String {
        switch self {
        case .unreachable:
            "Is ‘Let my phone connect’ on in Jarvis Settings? Your iPhone and Mac need the same Wi‑Fi, or Tailscale on both."
        case .unpaired:
            "Jarvis on your Mac doesn’t know this device anymore. Pair it again."
        case .wrongCode(let message):
            message.isEmpty ? "That code isn’t right, or it expired. Make a new one on the Mac." : message
        case .rejected(let message):
            message
        case .unavailable:
            "Jarvis can’t do that right now."
        case .timedOut:
            "Jarvis is taking a while. The reply will show up here when it’s ready."
        case .notJarvis:
            "Something answered at that address, but it isn’t the Jarvis companion. Check the address and port (usually 8765)."
        case .server(let status, let message):
            message ?? "HTTP \(status)"
        case .invalidAddress:
            "Enter the Mac’s address, like 192.168.1.20 or my-mac.local. The port is 8765 unless you changed it."
        }
    }

    var errorDescription: String? {
        switch self {
        case .unreachable: "Can’t reach the Mac — is ‘Let my phone connect’ on in Jarvis Settings?"
        default: "\(title). \(message)"
        }
    }
}

/// The Mac's companion API (jarvis.remote): bearer token, JSON, plain HTTP.
struct JarvisAPI: Sendable {
    let baseURL: URL
    var token: String?

    /// Trade the Mac's six-digit code for this device's own token.
    func pair(code: String, name: String) async throws -> String {
        let data = try await send("api/pair", body: ["code": code, "name": name], timeout: 12, authorized: false)
        guard let token = (try? JSONDecoder().decode(TokenBody.self, from: data))?.token, !token.isEmpty else {
            throw JarvisError.notJarvis
        }
        return token
    }

    func state() async throws -> RemoteState {
        let data: Data
        do {
            data = try await send("api/state", body: nil, timeout: 8)
        } catch JarvisError.timedOut {
            throw JarvisError.unreachable("The Mac didn’t answer in time.")
        }
        do {
            return try JSONDecoder().decode(RemoteState.self, from: data)
        } catch {
            throw JarvisError.notJarvis
        }
    }

    /// Returns when the reply is done, or early when the request needs a yes.
    /// The Mac waits up to two minutes for a reply, so this waits a little longer.
    func ask(_ text: String) async throws -> AskResult {
        let data = try await send("api/ask", body: ["text": text], timeout: 135)
        do {
            return try JSONDecoder().decode(AskResult.self, from: data)
        } catch {
            throw JarvisError.notJarvis
        }
    }

    /// False when the question was already answered (or timed out) on the Mac.
    func approve(id: String, choice: String) async throws -> Bool {
        let data = try await send("api/approve", body: ["id": id, "choice": choice], timeout: 10)
        return (try? JSONDecoder().decode(OkBody.self, from: data))?.ok ?? false
    }

    func command(_ command: MacCommand) async throws {
        _ = try await send("api/command", body: command.body, timeout: 15)
    }

    /// The text in JARVIS's own voice, as WAV. Throws `.unavailable` when the Mac can't speak.
    func say(_ text: String) async throws -> Data {
        try await send("api/say", body: ["text": text], timeout: 45)
    }

    // MARK: - Plumbing

    private func send(_ path: String, body: [String: String]?, timeout: TimeInterval, authorized: Bool = true) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .cancelled: throw CancellationError()
            case .timedOut: throw JarvisError.timedOut
            default: throw JarvisError.unreachable(error.localizedDescription)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw JarvisError.unreachable(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw JarvisError.notJarvis }
        switch http.statusCode {
        case 200..<300: return data
        case 401: throw JarvisError.unpaired
        case 403: throw JarvisError.wrongCode(Self.message(in: data) ?? "")
        case 400: throw JarvisError.rejected(Self.message(in: data) ?? "The Mac didn’t accept that.")
        case 404: throw JarvisError.notJarvis
        case 503: throw JarvisError.unavailable
        default: throw JarvisError.server(http.statusCode, Self.message(in: data))
        }
    }

    private static func message(in data: Data) -> String? {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
    }

    /// No cookies, no cache: every request carries only its bearer token.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForResource = 180
        return URLSession(configuration: configuration)
    }()
}

private struct TokenBody: Decodable { var token: String? }
private struct OkBody: Decodable { var ok: Bool? }
private struct ErrorBody: Decodable { var error: String? }
