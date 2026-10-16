import Foundation

/// What the Mac's "Pair the Eden Code app" QR code says (src/jarvis/features/code_phone_pair.py,
/// docs/eden-code-phone.md "Pairing by QR"), version 1:
///
///     edencode://pair?v=1&code=<6 digits>&host=<Mac .local name>&ip=<LAN IPv4>&port=<port>
///         &fp=<SHA-256 hex of the Mac's certificate>&name=<Mac name>&ts=<Tailscale host>&relay=1
///
/// `ip`, `name`, `ts` and `relay` are optional; parameters may come in any order and unknown
/// ones are ignored. The fingerprint is pinned before the first request, so the code only ever
/// goes to the Mac that showed it. The Eden Secretary companion's own QR code
/// (`jarvis-pair://host:port?code=…&fp=…&name=…`, PairingLink) is read too: the same pairing.
struct PairPayload: Equatable, Sendable {
    static let scheme = "edencode"
    static let version = 1

    enum Problem: Error, Equatable {
        case notEdenCode  // not a pairing code at all
        case newerVersion  // a Mac newer than this app: update Eden Code
        case incomplete  // ours, but something is missing or malformed
    }

    var code: String
    var host: String
    var ip: String?
    var port: Int
    var fingerprint: String
    var macName: String?
    var tailscale: String?
    var relay: Bool

    /// What to call the Mac while pairing.
    var label: String { macName ?? host }

    /// Where to try, in order: the .local name, the LAN address, Tailscale. Each one pinned to
    /// the same fingerprint, so trying several never sends the code anywhere else.
    var candidates: [URL] {
        var seen = Set<String>()
        return [host, ip, tailscale].compactMap { $0 }.filter { seen.insert($0.lowercased()).inserted }
            .compactMap { MacAddress.url(host: $0, port: port) }
    }

    init(code: String, host: String, ip: String? = nil, port: Int = MacAddress.defaultPort, fingerprint: String,
         macName: String? = nil, tailscale: String? = nil, relay: Bool = false) {
        self.code = code
        self.host = host
        self.ip = ip
        self.port = port
        self.fingerprint = fingerprint
        self.macName = macName
        self.tailscale = tailscale
        self.relay = relay
    }

    /// A scanned or opened code: Eden Code's own, or the companion's jarvis-pair link.
    static func parse(_ text: String) -> Result<PairPayload, Problem> {
        let text = text.trimmed
        let lower = text.lowercased()
        if lower.hasPrefix(PairingLink.scheme + "://") {
            guard let link = PairingLink(text), let host = link.baseURL.host() else { return .failure(.incomplete) }
            return .success(PairPayload(code: link.code, host: host, port: link.baseURL.port ?? MacAddress.defaultPort,
                                        fingerprint: link.fingerprint, macName: link.macName))
        }
        guard lower.hasPrefix(scheme + "://"), let components = URLComponents(string: text),
              components.host?.lowercased() == "pair" else { return .failure(.notEdenCode) }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            // URLComponents has already undone the percent-encoding; a "+" from a form encoder is a space.
            guard let raw = items.first(where: { $0.name.lowercased() == name })?.value else { return nil }
            let clean = raw.replacingOccurrences(of: "+", with: " ").trimmed
            return clean.isEmpty ? nil : clean
        }
        guard let versionText = value("v"), let version = Int(versionText) else { return .failure(.incomplete) }
        guard version <= Self.version else { return .failure(.newerVersion) }
        guard version >= 1,
              let code = value("code"), code.count == 6, code.allSatisfy({ $0.isASCII && $0.isNumber }),
              let host = value("host").flatMap(Self.hostName),
              let fingerprint = value("fp").flatMap(CertificatePin.normalize)
        else { return .failure(.incomplete) }
        var port = MacAddress.defaultPort
        if let portText = value("port") {
            guard let number = Int(portText), (1...65535).contains(number) else { return .failure(.incomplete) }
            port = number
        }
        return .success(PairPayload(
            code: code,
            host: host,
            ip: value("ip").flatMap(Self.ipv4),
            port: port,
            fingerprint: fingerprint,
            macName: value("name").map { String($0.prefix(80)) },
            tailscale: value("ts").flatMap(Self.hostName),
            relay: value("relay") == "1"
        ))
    }

    static func parse(_ url: URL) -> Result<PairPayload, Problem> { parse(url.absoluteString) }

    /// A host name or IPv4 address, nothing that could carry a path, a user or a port.
    static func hostName(_ text: String) -> String? {
        let host = text.hasSuffix(".") ? String(text.dropLast()) : text
        guard (1...253).contains(host.count),
              host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }),
              host.first != ".", host.first != "-", host.last != "-" else { return nil }
        return host
    }

    static func ipv4(_ text: String) -> String? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) && Int($0)! <= 255 })
        else { return nil }
        return text
    }

    /// What to tell the owner about a code that didn't parse.
    static func message(_ problem: Problem) -> String {
        switch problem {
        case .notEdenCode: "That isn’t an Eden Code pairing code. Use the one in Eden Code › On your phone on your Mac."
        case .newerVersion: "This code is from a newer Eden on your Mac. Update Eden Code from the App Store, then scan again."
        case .incomplete: "That pairing code is incomplete. Click New code on your Mac and scan again."
        }
    }
}
