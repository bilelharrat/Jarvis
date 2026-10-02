import Foundation
import Network

/// One end of a byte stream the relay tunnel copies: the local connection URLSession made,
/// or the WebSocket to askeden.com (fakes in tests).
protocol RelaySocket: AnyObject, Sendable {
    /// The next bytes (at most 64 KiB), or nil once this end has closed.
    func receive() async throws -> Data?
    func send(_ data: Data) async throws
    /// Closes it, and ends any receive waiting on it.
    func close()
}

/// Copies bytes both ways between two sockets until either end closes or fails, then closes
/// both. Nothing is read or changed on the way: it's the companion's own TLS.
enum RelayPump {
    /// The largest frame askeden.com's relay carries.
    static let maxFrame = 64 * 1024

    /// Returns whether the far end (the Mac) ever sent anything: a stream that ends without a
    /// byte from it never reached the Mac.
    @discardableResult
    static func run(local: any RelaySocket, upstream: any RelaySocket) async -> Bool {
        let heard = Flag()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await copy(from: local, to: upstream, heard: nil) }
            group.addTask { await copy(from: upstream, to: local, heard: heard) }
            await group.next()  // one side is done: so is the stream
            local.close()
            upstream.close()
        }
        return heard.isSet
    }

    private static func copy(from source: any RelaySocket, to sink: any RelaySocket, heard: Flag?) async {
        while !Task.isCancelled {
            guard let data = try? await source.receive() else { return }
            guard !data.isEmpty else { continue }
            heard?.set()
            var offset = 0
            while offset < data.count {  // never a frame over 64 KiB
                let end = min(offset + maxFrame, data.count)
                do {
                    try await sink.send(data.subdata(in: offset..<end))
                } catch {
                    return
                }
                offset = end
            }
        }
    }

    final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.withLock { value } }
        func set() { lock.withLock { value = true } }
    }
}

/// The iPhone's end of the encrypted relay: a listener on 127.0.0.1 (a random port) that
/// turns each connection URLSession makes into one relay stream to the Mac, a WebSocket to
/// `wss://askeden.com/api/relay/connect?to=<the Mac's device id>`. So JarvisAPI simply talks
/// to `https://127.0.0.1:<port>` with the Mac's pinned fingerprint, and TLS runs end to end:
/// askeden.com carries ciphertext it can't read.
final class RelayTunnel: @unchecked Sendable {
    static let connectURL = URL(string: "wss://askeden.com/api/relay/connect")!

    let macDeviceID: String
    private let makeUpstream: @Sendable () -> (any RelaySocket)?
    private let queue = DispatchQueue(label: "com.bshventures.jarvis.relay")
    private let lock = NSLock()
    private var listener: NWListener?
    private var readyPort: UInt16?
    private var lastRefused: Date?
    private var lastHeard: Date?

    /// upstream: a new relay stream (nil when signed out).
    init(macDeviceID: String, makeUpstream: @escaping @Sendable () -> (any RelaySocket)?) {
        self.macDeviceID = macDeviceID
        self.makeUpstream = makeUpstream
    }

    /// The live tunnel to this Mac, on this account's token.
    static func live(macDeviceID: String, session: URLSession = .shared) -> RelayTunnel {
        RelayTunnel(macDeviceID: macDeviceID) {
            guard let token = AccountKeychain.token,
                  var components = URLComponents(url: connectURL, resolvingAgainstBaseURL: false) else { return nil }
            components.queryItems = [URLQueryItem(name: "to", value: macDeviceID)]
            guard let url = components.url else { return nil }
            var request = URLRequest(url: url, timeoutInterval: 15)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return WebSocketRelaySocket(request: request, session: session)
        }
    }

    /// The port it listens on, once it is.
    var port: UInt16? { lock.withLock { readyPort } }

    /// Starts listening (once); the port.
    func start() async throws -> UInt16 {
        if let port { return port }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback  // nothing off this iPhone can connect
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let resumed = RelayPump.Flag()
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    guard !resumed.isSet else { return }
                    resumed.set()
                    if let port = listener.port?.rawValue {
                        continuation.resume(returning: port)
                    } else {
                        continuation.resume(throwing: NWError.posix(.EADDRNOTAVAIL))
                    }
                case .failed(let error):
                    guard !resumed.isSet else {
                        self?.dropped(listener)  // iOS took it away: the next request starts another
                        return
                    }
                    resumed.set()
                    continuation.resume(throwing: error)
                case .cancelled:
                    self?.dropped(listener)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        lock.withLock {
            self.listener = listener
            readyPort = port
        }
        return port
    }

    private func dropped(_ listener: NWListener) {
        lock.withLock {
            guard self.listener === listener else { return }
            self.listener = nil
            readyPort = nil
        }
    }

    func stop() {
        let listener = lock.withLock {
            defer { self.listener = nil; readyPort = nil }
            return self.listener
        }
        listener?.cancel()
    }

    /// A stream ended in the last few seconds without a byte from the Mac (it isn't on the
    /// relay, or askeden.com turned the stream down), and none has worked since.
    var refusedRecently: Bool {
        lock.withLock {
            guard let lastRefused, Date().timeIntervalSince(lastRefused) < 30 else { return false }
            return lastHeard.map { $0 < lastRefused } ?? true
        }
    }

    private func accept(_ connection: NWConnection) {
        let local = ConnectionRelaySocket(connection, queue: queue)
        guard let upstream = makeUpstream() else {
            local.close()
            return
        }
        Task {
            let heard = await RelayPump.run(local: local, upstream: upstream)
            self.lock.withLock {
                if heard { self.lastHeard = Date() } else { self.lastRefused = Date() }
            }
        }
    }
}

/// A loopback connection from URLSession.
final class ConnectionRelaySocket: RelaySocket, @unchecked Sendable {
    private let connection: NWConnection

    init(_ connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        connection.start(queue: queue)
    }

    func receive() async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: RelayPump.maxFrame) { data, _, isComplete, error in
                if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else if let error {
                    continuation.resume(throwing: error)
                } else if isComplete {
                    continuation.resume(returning: nil)
                } else {
                    continuation.resume(returning: Data())
                }
            }
        }
    }

    func send(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    func close() {
        connection.cancel()
    }
}

/// One relay stream: binary WebSocket frames are the raw bytes of one TCP connection.
final class WebSocketRelaySocket: RelaySocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(request: URLRequest, session: URLSession) {
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        task.resume()
    }

    func receive() async throws -> Data? {
        switch try await task.receive() {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: return Data()
        }
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}
