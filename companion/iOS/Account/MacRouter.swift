import Foundation
import Network

/// Chooses how the iPhone reaches its Mac (MacRoute): straight to its address while that
/// answers, else, when the owner is signed in to their Jarvis account and the Mac is linked
/// to it, through the encrypted relay. Whether the address answers is a quick TCP knock
/// (1.5 s at most), remembered for 30 seconds and forgotten whenever the network changes.
actor MacRouter: MacRoute.Router {
    static let shared = MacRouter()

    enum Route: Equatable, Sendable {
        case direct
        case relay
    }

    /// The whole decision. directReachable: the knock answered. relayRefused: a relay stream
    /// to this Mac just ended without a word from it (it isn't on the relay).
    static func decide(directReachable: Bool, signedIn: Bool, macDeviceID: String?, relayRefused: Bool) -> Route {
        guard !directReachable, signedIn, let macDeviceID, !macDeviceID.isEmpty, !relayRefused else { return .direct }
        return .relay
    }

    static let probeTimeout: TimeInterval = 1.5
    static let probeLife: TimeInterval = 30

    /// The pairing's address and the Mac's account device id, and whether this iPhone is
    /// signed in: read from the Keychain, again whenever either changes (reload()).
    private struct Config: Equatable {
        var direct: URL?
        var macDeviceID: String?
        var signedIn = false
    }

    private var config: Config?
    private var probes: [String: (at: Date, reachable: Bool)] = [:]
    private var tunnel: RelayTunnel?
    private var monitor: NWPathMonitor?
    /// The way the last request went, for the screen.
    private(set) var lastRoute: Route = .direct
    /// Knocks, for tests (host:port → reachable).
    private let knock: @Sendable (String, UInt16) async -> Bool

    init(knock: (@Sendable (String, UInt16) async -> Bool)? = nil) {
        self.knock = knock ?? { host, port in await MacRouter.probe(host: host, port: port, timeout: MacRouter.probeTimeout) }
    }

    /// Reads the pairing and the account again (after pairing, unpairing, signing in or out,
    /// or learning the Mac's device id).
    func reload() {
        let pairing = PairingStore.load()
        configure(direct: pairing?.baseURL, macDeviceID: pairing?.macDeviceID, signedIn: AccountKeychain.load() != nil)
    }

    func configure(direct: URL?, macDeviceID: String?, signedIn: Bool) {
        let next = Config(direct: direct, macDeviceID: macDeviceID, signedIn: signedIn)
        guard next != config else { return }
        config = next
        if tunnel?.macDeviceID != macDeviceID || !signedIn {
            tunnel?.stop()
            tunnel = nil
        }
        watchNetwork()
    }

    /// Whether requests to the Mac go through the relay right now.
    var isRelaying: Bool { lastRoute == .relay }

    // MARK: - MacRoute.Router

    func base(for direct: URL) async -> URL {
        if config == nil { reload() }
        guard let config, config.signedIn, let mac = config.macDeviceID, Self.same(direct, config.direct) else {
            return direct
        }
        let reachable = await isReachable(direct)
        let route = Self.decide(directReachable: reachable, signedIn: config.signedIn, macDeviceID: mac,
                                relayRefused: tunnel?.refusedRecently ?? false)
        lastRoute = route
        guard route == .relay, let relay = await relayBase(mac: mac) else {
            lastRoute = .direct
            return direct
        }
        return relay
    }

    func directFailed(_ direct: URL) async -> URL? {
        if config == nil { reload() }
        guard let config, config.signedIn, let mac = config.macDeviceID, Self.same(direct, config.direct),
              tunnel?.refusedRecently != true else { return nil }
        probes[Self.key(direct)] = (Date(), false)
        lastRoute = .relay
        return await relayBase(mac: mac)
    }

    func relayFailed(_ base: URL) async -> Bool {
        // The stream's end is noted a moment after URLSession hears it.
        for _ in 0..<5 {
            if tunnel?.refusedRecently == true {
                lastRoute = .direct
                return true
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    // MARK: - Plumbing

    private func relayBase(mac: String) async -> URL? {
        if tunnel == nil { tunnel = RelayTunnel.live(macDeviceID: mac) }
        guard let tunnel, let port = try? await tunnel.start() else { return nil }
        return URL(string: "https://127.0.0.1:\(port)")
    }

    private func isReachable(_ direct: URL) async -> Bool {
        let key = Self.key(direct)
        if let known = probes[key], Date().timeIntervalSince(known.at) < Self.probeLife { return known.reachable }
        guard let host = direct.host, let port = UInt16(exactly: direct.port ?? MacAddress.defaultPort) else { return true }
        let reachable = await knock(host, port)
        probes[key] = (Date(), reachable)
        return reachable
    }

    private func watchNetwork() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { await self?.networkChanged() }
        }
        monitor.start(queue: DispatchQueue(label: "com.bshventures.jarvis.route"))
        self.monitor = monitor
    }

    private func networkChanged() {
        probes = [:]
    }

    static func key(_ url: URL) -> String { "\(url.host ?? ""):\(url.port ?? MacAddress.defaultPort)" }

    static func same(_ a: URL, _ b: URL?) -> Bool {
        guard let b else { return false }
        return a.scheme == b.scheme && key(a) == key(b)
    }

    /// A TCP knock on the Mac's address: true when it connects within the timeout.
    static func probe(host: String, port: UInt16, timeout: TimeInterval) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return false }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let queue = DispatchQueue(label: "com.bshventures.jarvis.knock")
        return await withCheckedContinuation { continuation in
            let done = RelayPump.Flag()
            let finish: @Sendable (Bool) -> Void = { reachable in
                queue.async {
                    guard !done.isSet else { return }
                    done.set()
                    connection.cancel()
                    continuation.resume(returning: reachable)
                }
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(true)
                case .failed, .waiting, .cancelled: finish(false)
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) { finish(false) }
        }
    }
}
