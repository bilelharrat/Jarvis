import Foundation

/// What the iPhone hands the Watch over WatchConnectivity (application context, and the
/// reply when the Watch asks): the Mac's address and this pair's token, or "unpaired".
/// The link between the phone and the watch is encrypted by watchOS.
enum WatchLink {
    enum Update: Equatable, Sendable {
        case paired(Pairing)
        case unpaired
        case nothing
    }

    static let requestKey = "request"
    static let pairingRequest = "pairing"
    private static let baseURLKey = "baseURL"
    private static let tokenKey = "token"
    private static let macNameKey = "macName"
    private static let unpairedKey = "unpaired"
    private static let sentAtKey = "sentAt"

    static func context(for pairing: Pairing?) -> [String: Any] {
        var context: [String: Any] = [sentAtKey: Date().timeIntervalSince1970]
        if let pairing {
            context[baseURLKey] = pairing.baseURL.absoluteString
            context[tokenKey] = pairing.token
            context[macNameKey] = pairing.macName ?? ""
        } else {
            context[unpairedKey] = true
        }
        return context
    }

    static func update(from context: [String: Any]) -> Update {
        if context[unpairedKey] as? Bool == true { return .unpaired }
        guard let text = context[baseURLKey] as? String, let url = URL(string: text),
              let token = context[tokenKey] as? String, !token.isEmpty else { return .nothing }
        let name = (context[macNameKey] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let sent = (context[sentAtKey] as? Double).map(Date.init(timeIntervalSince1970:)) ?? Date()
        return .paired(Pairing(baseURL: url, token: token, macName: name, deviceName: "Apple Watch", pairedAt: sent))
    }
}
