import Foundation

/// Reply text as it should sound: markdown marks and links dropped, capped at what the
/// Mac will voice (1,500 characters), ending on a sentence where possible.
enum Speakable {
    static func clean(_ text: String) -> String {
        var out = text
        out = out.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+"#, with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: #"[*_`~]+"#, with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmed
        guard out.count > 1500 else { return out }
        let head = String(out.prefix(1500))
        if let end = head.lastIndex(where: { ".!?".contains($0) }), head.distance(from: head.startIndex, to: end) > 400 {
            return String(head[...end])
        }
        return head
    }

    /// The language to say a reply in with the device's own voice (a BCP-47 tag for
    /// AVSpeechSynthesisVoice). Jarvis answers in English or Chinese, as it was asked: a
    /// Chinese reply gets the person's own Chinese (Taiwan, Hong Kong) or else Mandarin as
    /// spoken in China, and any other reply their own English or else US English.
    static func voiceLanguage(for text: String, preferred: [String] = Locale.preferredLanguages) -> String {
        let tags = preferred.map(voiceTag)
        if isChinese(text) {
            return tags.first { $0.hasPrefix("zh-") } ?? "zh-CN"
        }
        return tags.first { $0.hasPrefix("en-") } ?? "en-US"
    }

    /// Han characters outweigh Latin letters, counting a character as a word of four letters,
    /// so a Chinese reply that names "Eden Code" is still Chinese, and an English one that
    /// names someone in Chinese is still English.
    private static func isChinese(_ text: String) -> Bool {
        var han = 0
        var latin = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF: han += 1
            case 0x41...0x5A, 0x61...0x7A: latin += 1
            default: break
            }
        }
        return han > 0 && han * 4 >= latin
    }

    /// A preferred language as a voice's tag: "zh-Hant-TW" → "zh-TW", "zh-Hans" → "zh-CN",
    /// "en-GB" → "en-GB", "en" → "en".
    private static func voiceTag(_ identifier: String) -> String {
        let parts = identifier.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
        guard let language = parts.first?.lowercased() else { return identifier }
        let subtags = parts.dropFirst()
        let region = subtags.first { $0.count == 2 || ($0.count == 3 && $0.allSatisfy(\.isNumber)) }?.uppercased()
        if language == "zh" {
            if let region, ["CN", "TW", "HK"].contains(region) { return "zh-\(region)" }
            let traditional = subtags.contains { $0.lowercased() == "hant" }
            return traditional ? "zh-TW" : "zh-CN"
        }
        return region.map { "\(language)-\($0)" } ?? language
    }
}
