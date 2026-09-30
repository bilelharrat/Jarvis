import Foundation

/// Turns what someone types for the Mac ("192.168.1.20", "mac.local:8766",
/// "https://100.101.102.103", a Tailscale IP) into the companion's base URL. The companion
/// speaks only TLS (to the Mac's pinned certificate), so every address becomes https.
enum MacAddress {
    static let defaultPort = 8765

    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmed
        let scheme = "https"
        let lower = text.lowercased()
        if lower.hasPrefix("http://") {
            text.removeFirst(7)  // the Mac no longer serves the app over plain HTTP
        } else if lower.hasPrefix("https://") {
            text.removeFirst(8)
        } else if text.contains("://") {
            return nil
        }
        if let cut = text.firstIndex(where: { "/?#".contains($0) }) {
            text = String(text[..<cut])  // no paths: the API lives at the root
        }
        guard !text.isEmpty, !text.contains(where: { $0.isWhitespace || $0 == "@" || $0 == "%" }) else { return nil }

        var host = text
        var port: Int?
        if text.hasPrefix("[") {  // [IPv6]:port
            guard let close = text.firstIndex(of: "]") else { return nil }
            host = String(text[text.index(after: text.startIndex)..<close])
            let rest = text[text.index(after: close)...]
            if rest.hasPrefix(":") {
                guard let value = Int(rest.dropFirst()) else { return nil }
                port = value
            } else if !rest.isEmpty {
                return nil
            }
        } else if text.filter({ $0 == ":" }).count == 1 {
            let parts = text.split(separator: ":", omittingEmptySubsequences: false)
            host = String(parts[0])
            guard let value = Int(parts[1]) else { return nil }
            port = value
        }  // more than one colon and no brackets: a bare IPv6 address, no port

        if let port, !(1...65535).contains(port) { return nil }
        return url(scheme: scheme, host: host, port: port ?? defaultPort)
    }

    static func url(scheme: String = "https", host: String, port: Int?) -> URL? {
        let host = host.trimmed
        guard !host.isEmpty else { return nil }
        let hostPart = host.contains(":") ? "[\(host)]" : host
        let portPart = port.map { ":\($0)" } ?? ""
        guard let url = URL(string: "\(scheme)://\(hostPart)\(portPart)"), url.host != nil else { return nil }
        return url
    }

    /// "192.168.1.20:8765", for showing to people.
    static func display(_ url: URL) -> String {
        var text = url.absoluteString
        if text.hasPrefix("https://") {
            text.removeFirst(8)
        } else if text.hasPrefix("http://") {
            text.removeFirst(7)
        }
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }
}
