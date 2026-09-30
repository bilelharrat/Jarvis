import Foundation
import Network

/// Finds Macs running Jarvis on the local network: Bonjour service `_jarvis._tcp`.
/// Nothing may be advertising yet; then the list just stays empty and the address field
/// does the job.
@MainActor
@Observable
final class BonjourBrowser {
    struct Mac: Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
        /// A stable host name from the TXT record ("host=Bilels-MacBook.local"), when given.
        let host: String?
        /// The Mac says it speaks TLS ("tls=1").
        var tls = false
        /// The short fingerprint it announces ("fp=a1b2 c3d4 e5f6 0718"): a hint to warn on,
        /// never a reason to trust.
        var fingerprintHint: String?
    }

    static let serviceType = "_jarvis._tcp"

    private(set) var macs: [Mac] = []
    private(set) var searching = false
    /// Why browsing can't work (e.g. Local Network access is off).
    private(set) var problem: String?

    @ObservationIgnored private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: parameters)
        browser.browseResultsChangedHandler = Self.onResults { [weak self] macs in
            self?.macs = macs
        }
        browser.stateUpdateHandler = Self.onState { [weak self] searching, problem in
            self?.searching = searching
            self?.problem = problem
        }
        browser.start(queue: .main)
        self.browser = browser
        searching = true
    }

    func stop() {
        browser?.cancel()
        browser = nil
        searching = false
    }

    /// The companion's base URL (https) for a found Mac: its TXT host name if it gave one,
    /// else its IPv4 address, with the advertised port.
    func address(of mac: Mac) async throws -> URL {
        let (host, port) = try await Self.resolve(mac.endpoint)
        guard let url = MacAddress.url(host: mac.host ?? host, port: port) else {
            throw JarvisError.unreachable("Couldn’t work out \(mac.name)’s address.")
        }
        return url
    }

    // MARK: - Handlers (called on the main queue, where the browser runs)

    nonisolated private static func onResults(_ update: @escaping @MainActor ([Mac]) -> Void) -> @Sendable (Set<NWBrowser.Result>, Set<NWBrowser.Result.Change>) -> Void {
        { results, _ in
            let macs = results.compactMap(mac(from:)).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            MainActor.assumeIsolated { update(macs) }
        }
    }

    nonisolated private static func onState(_ update: @escaping @MainActor (Bool, String?) -> Void) -> @Sendable (NWBrowser.State) -> Void {
        { state in
            let report: (Bool, String?)
            switch state {
            case .ready, .setup: report = (true, nil)
            case .waiting(let error), .failed(let error): report = (false, describe(error))
            case .cancelled: report = (false, nil)
            @unknown default: report = (false, nil)
            }
            MainActor.assumeIsolated { update(report.0, report.1) }
        }
    }

    nonisolated private static func mac(from result: NWBrowser.Result) -> Mac? {
        guard case let .service(name, _, _, _) = result.endpoint else { return nil }
        var host: String?
        var tls = false
        var hint: String?
        if case let .bonjour(record) = result.metadata {
            if let value = record["host"]?.trimmed, !value.isEmpty { host = value }
            tls = record["tls"]?.trimmed == "1"
            if let value = record["fp"]?.trimmed, !value.isEmpty { hint = String(value.prefix(40)) }
        }
        return Mac(id: "\(name)|\(host ?? "")", name: name, endpoint: result.endpoint, host: host, tls: tls, fingerprintHint: hint)
    }

    nonisolated private static func describe(_ error: NWError) -> String {
        if case let .dns(code) = error, code == -65570 {  // kDNSServiceErr_PolicyDenied
            return "Local Network access is off for J.A.R.V.I.S. Turn it on in Settings › Privacy & Security › Local Network, or type the address."
        }
        return "Can’t look for Macs right now. Type the address instead."
    }

    /// Opens (and at once closes) a connection to the service to learn its IPv4 address
    /// and port.
    nonisolated private static func resolve(_ endpoint: NWEndpoint) async throws -> (String, Int) {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: parameters)
        let once = Once()
        return try await withCheckedThrowingContinuation { continuation in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint {
                        once.run { continuation.resume(returning: (text(of: host), Int(port.rawValue))) }
                    } else {
                        once.run { continuation.resume(throwing: JarvisError.unreachable("No address for that Mac.")) }
                    }
                    connection.cancel()
                case .failed(let error), .waiting(let error):
                    once.run { continuation.resume(throwing: JarvisError.unreachable(error.localizedDescription)) }
                    connection.cancel()
                case .cancelled:
                    once.run { continuation.resume(throwing: JarvisError.unreachable("Cancelled.")) }
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + 6) {
                once.run { continuation.resume(throwing: JarvisError.unreachable("That Mac didn’t answer.")) }
                connection.cancel()
            }
        }
    }

    nonisolated private static func text(of host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let address):
            return address.rawValue.map(String.init).joined(separator: ".")
        case .ipv6(let address):
            return "\(address)".split(separator: "%").first.map(String.init) ?? "\(address)"
        case .name(let name, _):
            return name
        @unknown default:
            return "\(host)"
        }
    }
}

/// Runs its block once, whichever callback gets there first.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func run(_ block: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { block() }
    }
}
