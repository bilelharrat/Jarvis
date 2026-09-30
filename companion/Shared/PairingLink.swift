import Foundation

/// What the Mac's pairing QR code says:
/// `jarvis-pair://<host>:<port>?code=<6 digits>&fp=<fingerprint>&name=<Mac name>`.
/// The fingerprint in it is pinned before the first request, so the code only ever goes
/// to the Mac that showed it.
struct PairingLink: Equatable, Sendable {
    static let scheme = "jarvis-pair"

    var baseURL: URL
    var code: String
    var fingerprint: String
    var macName: String?

    init(baseURL: URL, code: String, fingerprint: String, macName: String? = nil) {
        self.baseURL = baseURL
        self.code = code
        self.fingerprint = fingerprint
        self.macName = macName
    }

    /// Nil unless it's a complete, well-formed pairing link.
    init?(_ text: String) {
        let text = text.trimmed
        guard text.lowercased().hasPrefix(Self.scheme + "://"),
              let components = URLComponents(string: text),
              let rawHost = components.host else { return nil }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))  // IPv6
        guard !host.isEmpty, !host.contains(where: { $0.isWhitespace || $0 == "@" }) else { return nil }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name.lowercased() == name }?.value?.trimmed
        }
        guard let code = value("code"), code.count == 6, code.allSatisfy(\.isASCII), code.allSatisfy(\.isNumber),
              let fingerprint = value("fp").flatMap(CertificatePin.normalize),
              let url = MacAddress.url(host: host, port: components.port ?? MacAddress.defaultPort)
        else { return nil }
        baseURL = url
        self.code = code
        self.fingerprint = fingerprint
        // Form-encoded names may use "+" for spaces.
        macName = value("name").map { $0.replacingOccurrences(of: "+", with: " ").trimmed }
            .flatMap { $0.isEmpty ? nil : String($0.prefix(80)) }
    }

    /// What to call the Mac before pairing: its name, else its address.
    var label: String { macName ?? MacAddress.display(baseURL) }
}
