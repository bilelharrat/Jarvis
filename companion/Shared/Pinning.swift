import CryptoKit
import Foundation
import Security

/// The Mac's companion server presents a self-signed certificate. This device trusts it
/// only by the SHA-256 of its DER bytes (its fingerprint), pinned when pairing: from the QR
/// code, or read from the connection and compared by eye with the Mac's Settings.
enum CertificatePin {
    /// Lowercase hex SHA-256 of the certificate's DER bytes, the contract's `fingerprint`.
    static func fingerprint(of der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    static func fingerprint(of certificate: SecCertificate) -> String {
        fingerprint(of: SecCertificateCopyData(certificate) as Data)
    }

    /// A fingerprint as 64 lowercase hex characters, however it was written ("A1:B2:…",
    /// "a1b2 c3d4 …"); nil when it isn't one.
    static func normalize(_ text: String) -> String? {
        let hex = text.lowercased().filter { !": -".contains($0) }
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return nil }
        return hex
    }

    /// "a1b2 c3d4 e5f6 0718": the first 16 hex characters in four groups, the way the Mac's
    /// Settings shows it for people to compare.
    static func short(_ fingerprint: String) -> String {
        let hex = normalize(fingerprint) ?? fingerprint.lowercased()
        let head = Array(hex.prefix(16))
        return stride(from: 0, to: head.count, by: 4)
            .map { String(head[$0..<min($0 + 4, head.count)]) }
            .joined(separator: " ")
    }

    /// Whether a short form (from Bonjour, say) agrees with a full fingerprint.
    static func shortMatches(_ short: String, _ fingerprint: String) -> Bool {
        let hint = short.lowercased().filter(\.isHexDigit)
        guard hint.count >= 8, let full = normalize(fingerprint) else { return false }
        return full.hasPrefix(hint)
    }

    /// Trust a server only when the certificate it presented is exactly the pinned one.
    /// No pin, no trust.
    static func accepts(presented: String?, pinned: String?) -> Bool {
        guard let presented = presented.flatMap(normalize), let pinned = pinned.flatMap(normalize) else { return false }
        return presented == pinned
    }

    /// The certificate the server presented: the first in its chain.
    static func leaf(of trust: SecTrust) -> SecCertificate? {
        (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    }
}

/// Answers the TLS server-trust challenge for one request: with a pin, only that exact
/// certificate is accepted; in capture mode the presented certificate is noted and the
/// connection refused, so nothing is ever sent to a server not yet trusted.
final class ServerTrustDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    enum Mode: Equatable {
        case pin(String)
        case capture
    }

    private let mode: Mode
    private let lock = NSLock()
    private var presentedValue: String?
    private var rejectedValue = false

    init(_ mode: Mode) {
        self.mode = mode
    }

    /// The fingerprint of the certificate the server presented, once it has.
    var presented: String? { lock.withLock { presentedValue } }
    /// The server presented a certificate other than the pinned one (or this was a capture).
    var rejected: Bool { lock.withLock { rejectedValue } }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let disposition = evaluate(trust)
        completionHandler(disposition, disposition == .useCredential ? URLCredential(trust: trust) : nil)
    }

    /// Decides for one presented certificate chain, and remembers what it saw.
    func evaluate(_ trust: SecTrust) -> URLSession.AuthChallengeDisposition {
        let (disposition, presented) = Self.decide(trust: trust, mode: mode)
        lock.withLock {
            presentedValue = presented
            if disposition != .useCredential { rejectedValue = true }
        }
        return disposition
    }

    /// The whole decision, apart from URLSession: use the credential only for the pinned
    /// certificate.
    static func decide(trust: SecTrust, mode: Mode) -> (URLSession.AuthChallengeDisposition, String?) {
        let presented = CertificatePin.leaf(of: trust).map(CertificatePin.fingerprint(of:))
        switch mode {
        case .pin(let pinned) where CertificatePin.accepts(presented: presented, pinned: pinned):
            return (.useCredential, presented)
        default:
            return (.cancelAuthenticationChallenge, presented)
        }
    }
}

/// One URLSession per pinned certificate, so a connection trusted under one pin is never
/// reused for a request made under another. No cookies, no cache: every request carries
/// only its bearer token.
enum PinnedSessions {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var sessions: [String: URLSession] = [:]

    static func session(for fingerprint: String) -> URLSession {
        lock.withLock {
            if let session = sessions[fingerprint] { return session }
            let session = URLSession(configuration: configuration())
            sessions[fingerprint] = session
            return session
        }
    }

    /// For reading a certificate before it's trusted: its own session, never reused.
    static func probeSession() -> URLSession {
        let configuration = configuration()
        configuration.timeoutIntervalForResource = 15
        return URLSession(configuration: configuration)
    }

    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForResource = 180
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        return configuration
    }
}
