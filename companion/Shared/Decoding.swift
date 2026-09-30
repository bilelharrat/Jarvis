import Foundation

// Forgiving reads for the companion API: the Mac side is Python and evolves, so a field
// that goes missing, turns null or changes from a number to a string must not break the app.

extension KeyedDecodingContainer {
    /// A string, or a number or bool written as one.
    func text(_ key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return String(value) }
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
        }
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return String(value) }
        return nil
    }

    func number(_ key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(String.self, forKey: key) { return Double(value.trimmed) }
        return nil
    }

    /// A whole number, from an int, a float that is one, or a numeric string. Never traps on
    /// a value too big for Int.
    func integer(_ key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        guard let value = number(key), value.isFinite, abs(value) < 9e15 else { return nil }
        return Int(value.rounded(.towardZero))
    }

    /// A moment: epoch seconds (or milliseconds) as a number or numeric string, or an ISO 8601
    /// timestamp with or without a zone.
    func date(_ key: Key) -> Date? {
        if let value = number(key) { return LooseDate.epoch(value) }
        guard let text = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return LooseDate.parse(text)
    }

    func flag(_ key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value != 0 }
        return nil
    }

    func object<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// The items that decode; the ones that don't are skipped.
    func list<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        guard var items = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !items.isAtEnd {
            if let item = try? items.decode(T.self) {
                out.append(item)
            } else if (try? items.decode(Skipped.self)) == nil {
                break  // can't step past it: stop rather than loop
            }
        }
        return out
    }
}

/// Consumes one value of any shape.
private struct Skipped: Decodable {
    init(from decoder: Decoder) throws {}
}

/// The Mac's timestamps: local ISO 8601 without a zone ("2026-09-29T14:30" or with
/// seconds), or with one.
enum LooseDate {
    private static let local: [DateFormatter] = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"].map {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = $0
        return formatter
    }

    private static let zoned: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Epoch seconds; a value that can only be milliseconds is read as such.
    static func epoch(_ value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value > 1e11 ? value / 1000 : value)
    }

    static func parse(_ text: String) -> Date? {
        let text = text.trimmed
        guard !text.isEmpty else { return nil }
        if let value = Double(text), text.allSatisfy({ $0.isNumber || $0 == "." }) { return epoch(value) }
        if let date = zoned.date(from: text) { return date }
        let plain = String(text.prefix(19))  // drop fractions of a second
        for formatter in local {
            if let date = formatter.date(from: plain) { return date }
        }
        return nil
    }
}
