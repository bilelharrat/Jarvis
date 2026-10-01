import Foundation

// The rest of the companion API (see COMPANION_API.md on the Mac side): Jarvis Code, the
// digest, delegations, spending, routines, pairing, push. Decoded as leniently as the state:
// a missing or oddly typed field falls back, a bad list item is skipped.

// MARK: - Jarvis Code

enum CodeStatus: String, Equatable, Hashable, Sendable, Codable {
    case working
    case needsYou = "needs_you"
    case done, failed, idle, resting
    case unknown

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = CodeStatus(rawValue: raw.lowercased()) ?? .unknown
    }

    /// Working, or waiting on the owner: worth a Live Activity.
    var isLive: Bool { self == .working || self == .needsYou }

    var label: String {
        switch self {
        case .working: "Working"
        case .needsYou: "Needs you"
        case .done: "Done"
        case .failed: "Failed"
        case .idle: "Idle"
        case .resting: "Resting"
        case .unknown: "—"
        }
    }

    var symbol: String {
        switch self {
        case .working: "gearshape.2.fill"
        case .needsYou: "hand.raised.fill"
        case .done: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .idle, .resting, .unknown: "moon.zzz.fill"
        }
    }
}

/// A session as /api/state lists it.
struct CodeSessionSummary: Identifiable, Equatable, Hashable, Sendable, Codable {
    var id: Int
    var title: String
    var project: String
    var status: CodeStatus

    init(id: Int, title: String, project: String = "", status: CodeStatus) {
        self.id = id
        self.title = title
        self.project = project
        self.status = status
    }

    private enum Key: String, CodingKey { case id, title, project, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.integer(.id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "session without an id"))
        }
        self.id = id
        project = c.text(.project) ?? ""
        title = c.text(.title).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? (project.isEmpty ? "Jarvis Code" : project)
        status = c.object(CodeStatus.self, .status) ?? .unknown
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(project, forKey: .project)
        try c.encode(status.rawValue, forKey: .status)
    }
}

/// What a session is waiting on the owner for.
struct CodeWaiting: Equatable, Sendable, Decodable {
    var approvalID: String
    var question: String

    init(approvalID: String, question: String) {
        self.approvalID = approvalID
        self.question = question
    }

    private enum Key: String, CodingKey {
        case question
        case approvalID = "approval_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.approvalID), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "waiting without an approval"))
        }
        approvalID = id
        question = c.text(.question) ?? "Jarvis Code needs your OK."
    }
}

/// GET /api/code/sessions
struct CodeSession: Identifiable, Equatable, Sendable, Decodable {
    var id: Int
    var title: String
    var project: String
    var branch: String
    var status: CodeStatus
    var mode: String
    var model: String
    var costUSD: Double?
    var updatedAt: Date?
    var waiting: CodeWaiting?

    private enum Key: String, CodingKey {
        case id, title, project, branch, status, mode, model, waiting
        case costUSD = "cost_usd"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.integer(.id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "session without an id"))
        }
        self.id = id
        project = c.text(.project) ?? ""
        title = c.text(.title).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? (project.isEmpty ? "Jarvis Code" : project)
        branch = c.text(.branch) ?? ""
        status = c.object(CodeStatus.self, .status) ?? .unknown
        mode = c.text(.mode) ?? ""
        model = c.text(.model) ?? ""
        costUSD = c.number(.costUSD)
        updatedAt = c.date(.updatedAt)
        waiting = c.object(CodeWaiting.self, .waiting)
    }

    var summary: CodeSessionSummary { CodeSessionSummary(id: id, title: title, project: project, status: status) }
}

struct CodeSessionList: Equatable, Sendable, Decodable {
    var sessions: [CodeSession]

    private enum Key: String, CodingKey { case sessions }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        sessions = c.list(CodeSession.self, .sessions)
    }
}

struct CodeEntry: Identifiable, Equatable, Sendable, Decodable {
    enum Role: String, Sendable {
        case user, assistant, tool, note
    }

    /// Its index in the session's transcript.
    var i: Int
    var role: Role
    var text: String
    var at: Date?
    /// A request of the owner's: what Rewind goes back to.
    var uuid: String?

    var id: Int { i }

    init(i: Int, role: Role, text: String, at: Date? = nil) {
        self.i = i
        self.role = role
        self.text = text
        self.at = at
    }

    private enum Key: String, CodingKey { case i, role, text, at, uuid }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let index = c.integer(.i) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "entry without an index"))
        }
        i = index
        role = Role(rawValue: c.text(.role) ?? "") ?? .note
        text = c.text(.text) ?? ""
        at = c.date(.at)
        uuid = c.text(.uuid)
    }
}

struct CodeTodo: Equatable, Hashable, Sendable, Decodable {
    var text: String
    var done: Bool

    init(text: String, done: Bool) {
        self.text = text
        self.done = done
    }

    private enum Key: String, CodingKey { case text, done }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        text = c.text(.text) ?? ""
        done = c.flag(.done) ?? false
    }
}

/// GET /api/code/session?id=…&after=…
struct CodeSessionDetail: Equatable, Sendable, Decodable {
    var id: Int
    var title: String
    var status: CodeStatus
    var entries: [CodeEntry]
    var todos: [CodeTodo]
    var waiting: CodeWaiting?
    /// Its settings: permission mode (plan, ask, edits, smart, auto), model, effort.
    var mode = ""
    var model = ""
    var modelLabel = ""
    var effort = ""
    var project = ""
    /// Messages still waiting for it to finish its step.
    var queued: [CodeQueued] = []

    /// The most entries one answer carries: a full page means there may be more.
    static let page = 200

    private enum Key: String, CodingKey {
        case id, title, status, entries, todos, waiting, mode, model, effort, project, queued
        case modelLabel = "model_label"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = c.integer(.id) ?? -1
        title = c.text(.title) ?? "Jarvis Code"
        status = c.object(CodeStatus.self, .status) ?? .unknown
        entries = c.list(CodeEntry.self, .entries).sorted { $0.i < $1.i }
        todos = c.list(CodeTodo.self, .todos).filter { !$0.text.trimmed.isEmpty }
        waiting = c.object(CodeWaiting.self, .waiting)
        mode = c.text(.mode) ?? ""
        model = c.text(.model) ?? ""
        modelLabel = c.text(.modelLabel) ?? ""
        effort = c.text(.effort) ?? ""
        project = c.text(.project) ?? ""
        queued = c.list(CodeQueued.self, .queued)
    }
}

/// A message waiting for a session's step to end.
struct CodeQueued: Identifiable, Equatable, Sendable, Decodable {
    var item: Int
    var text: String
    var id: Int { item }

    private enum Key: String, CodingKey { case item, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let item = c.integer(.item) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "queued without an item"))
        }
        self.item = item
        text = c.text(.text) ?? ""
    }
}

/// The transcript as this device holds it: entries by index, appended in order, bounded.
struct CodeTranscript: Equatable, Sendable {
    private(set) var entries: [CodeEntry] = []
    static let limit = 600

    /// The index to ask for entries after; nil before the first load (the Mac sends the tail).
    var after: Int? { entries.last?.i }

    /// Adds what's new; returns how many were added.
    @discardableResult
    mutating func merge(_ incoming: [CodeEntry]) -> Int {
        let last = entries.last?.i ?? Int.min
        let fresh = incoming.filter { $0.i > last }.sorted { $0.i < $1.i }
        var seen = Set<Int>()
        let unique = fresh.filter { seen.insert($0.i).inserted }
        entries.append(contentsOf: unique)
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
        return unique.count
    }
}

struct DiffHunk: Equatable, Sendable, Decodable {
    var header: String
    var lines: [String]

    private enum Key: String, CodingKey { case header, lines }

    init(header: String, lines: [String]) {
        self.header = header
        self.lines = lines
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        header = c.text(.header) ?? ""
        lines = c.list(String.self, .lines)
    }
}

struct DiffFile: Identifiable, Equatable, Sendable, Decodable {
    enum Status: String, Sendable {
        case modified = "M", added = "A", deleted = "D"

        var label: String {
            switch self {
            case .modified: "Modified"
            case .added: "Added"
            case .deleted: "Deleted"
            }
        }
    }

    var path: String
    var status: Status
    var added: Int
    var removed: Int
    var hunks: [DiffHunk]

    var id: String { path }
    /// Listed without any lines: a credential file, or nothing to show.
    var isHidden: Bool { hunks.allSatisfy(\.lines.isEmpty) }

    private enum Key: String, CodingKey { case path, status, added, removed, hunks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let path = c.text(.path), !path.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "file without a path"))
        }
        self.path = path
        status = Status(rawValue: (c.text(.status) ?? "M").uppercased()) ?? .modified
        added = max(0, c.integer(.added) ?? 0)
        removed = max(0, c.integer(.removed) ?? 0)
        hunks = c.list(DiffHunk.self, .hunks)
    }
}

/// GET /api/code/diff?id=…
struct CodeDiff: Equatable, Sendable, Decodable {
    var files: [DiffFile]

    private enum Key: String, CodingKey { case files }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        files = c.list(DiffFile.self, .files)
    }

    var added: Int { files.reduce(0) { $0 + $1.added } }
    var removed: Int { files.reduce(0) { $0 + $1.removed } }
}

/// One line of a hunk, by its first character.
enum DiffLineKind: Equatable {
    case context, added, removed

    init(_ line: String) {
        switch line.first {
        case "+": self = .added
        case "-": self = .removed
        default: self = .context
        }
    }
}

// MARK: - What did I miss

struct DigestItem: Identifiable, Equatable, Sendable, Decodable {
    enum Kind: String, Sendable {
        case text, email, call, voicemail, other

        var symbol: String {
            switch self {
            case .text: "message.fill"
            case .email: "envelope.fill"
            case .call: "phone.arrow.down.left.fill"
            case .voicemail: "recordingtape"
            case .other: "bell.fill"
            }
        }

        var label: String {
            switch self {
            case .text: "Message"
            case .email: "Email"
            case .call: "Missed call"
            case .voicemail: "Voicemail"
            case .other: "Update"
            }
        }
    }

    var who: String
    var kind: Kind
    var summary: String
    var at: Date?
    var urgent: Bool

    var id: String { "\(kind.rawValue)|\(who)|\(at?.timeIntervalSince1970 ?? 0)|\(summary.prefix(40))" }

    private enum Key: String, CodingKey { case who, kind, summary, at, urgent }

    init(who: String, kind: Kind, summary: String, at: Date?, urgent: Bool) {
        self.who = who
        self.kind = kind
        self.summary = summary
        self.at = at
        self.urgent = urgent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        who = c.text(.who).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? "Someone"
        kind = Kind(rawValue: (c.text(.kind) ?? "").lowercased()) ?? .other
        summary = c.text(.summary) ?? ""
        at = c.date(.at)
        urgent = c.flag(.urgent) ?? false
    }
}

struct Digest: Equatable, Sendable, Decodable {
    var items: [DigestItem]

    private enum Key: String, CodingKey { case items }

    init(items: [DigestItem]) {
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        items = c.list(DigestItem.self, .items)
    }

    /// Urgent first, then newest first.
    var sorted: [DigestItem] {
        items.sorted { a, b in
            if a.urgent != b.urgent { return a.urgent }
            return (a.at ?? .distantPast) > (b.at ?? .distantPast)
        }
    }

    /// A few sentences for Siri: how many, then the most important few.
    var spoken: String {
        let items = sorted
        guard !items.isEmpty else { return "Nothing new in the last day." }
        let count = items.count == 1 ? "One thing" : "\(items.count) things"
        let lines = items.prefix(3).map { item -> String in
            let summary = item.summary.trimmed
            let lead = item.urgent ? "Urgent, from \(item.who)" : "\(item.kind.label) from \(item.who)"
            return summary.isEmpty ? "\(lead)." : "\(lead): \(summary.trimmingCharacters(in: CharacterSet(charactersIn: ".")))."
        }
        let more = items.count > 3 ? " And \(items.count - 3) more in the app." : ""
        return "\(count) in the last day. " + lines.joined(separator: " ") + more
    }
}

// MARK: - Delegations

struct DelegationItem: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var with: String
    var goal: String
    var status: String
    var messages: Int
    var updatedAt: Date?

    private enum Key: String, CodingKey {
        case id, with, goal, status, messages
        case updatedAt = "updated_at"
    }

    init(id: String, with: String, goal: String, status: String, messages: Int = 0, updatedAt: Date? = nil) {
        self.id = id
        self.with = with
        self.goal = goal
        self.status = status
        self.messages = messages
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "delegation without an id"))
        }
        self.id = id
        with = c.text(.with).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? "Someone"
        goal = c.text(.goal) ?? ""
        status = (c.text(.status) ?? "active").lowercased()
        messages = max(0, c.integer(.messages) ?? 0)
        updatedAt = c.date(.updatedAt)
    }

    /// Still going: talking, or waiting on the owner.
    var isOpen: Bool { status == "active" || status == "waiting_owner" }
    var needsOwner: Bool { status == "waiting_owner" }

    var statusLabel: String {
        switch status {
        case "active": "Talking"
        case "waiting_owner": "Needs you"
        case "done": "Done"
        case "stopped": "Stopped"
        case "expired": "Expired"
        default: status.replacingOccurrences(of: "_", with: " ").capitalizedFirst
        }
    }
}

struct DelegationList: Equatable, Sendable, Decodable {
    var items: [DelegationItem]

    private enum Key: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        items = c.list(DelegationItem.self, .items)
    }
}

// MARK: - Spending

struct SpendItem: Identifiable, Equatable, Sendable, Decodable {
    var at: Date?
    var merchant: String
    var amount: Double
    var currency: String
    var kind: String

    var id: String { "\(at?.timeIntervalSince1970 ?? 0)|\(merchant)|\(amount)" }

    private enum Key: String, CodingKey { case at, merchant, amount, currency, kind }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        at = c.date(.at)
        merchant = c.text(.merchant).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? "Purchase"
        amount = c.number(.amount) ?? 0
        currency = (c.text(.currency) ?? "USD").uppercased()
        kind = (c.text(.kind) ?? "purchase").lowercased()
    }
}

struct SpendLimits: Equatable, Sendable, Decodable {
    var purchase: Double?
    var transfer: Double?
    var day: Double?
    var currency: String

    init(purchase: Double? = nil, transfer: Double? = nil, day: Double? = nil, currency: String = "USD") {
        self.purchase = purchase
        self.transfer = transfer
        self.day = day
        self.currency = currency
    }

    private enum Key: String, CodingKey { case purchase, transfer, day, currency }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        purchase = c.number(.purchase)
        transfer = c.number(.transfer)
        day = c.number(.day)
        currency = (c.text(.currency) ?? "USD").uppercased()
    }
}

/// GET /api/spending
struct Spending: Equatable, Sendable, Decodable {
    var recent: [SpendItem]
    var limits: SpendLimits
    var todayTotal: Double

    private enum Key: String, CodingKey {
        case recent, limits
        case todayTotal = "today_total"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        recent = c.list(SpendItem.self, .recent).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
        limits = c.object(SpendLimits.self, .limits) ?? SpendLimits()
        todayTotal = c.number(.todayTotal) ?? 0
    }

    /// How much of the day's limit is used, 0...1; nil without a limit.
    var dayUsed: Double? {
        guard let day = limits.day, day > 0 else { return nil }
        return min(1, max(0, todayTotal / day))
    }
}

// MARK: - Routines

/// GET /api/routines
struct RoutineItem: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var name: String
    var scheduleText: String
    var enabled: Bool
    var nextRun: Date?
    /// Given by newer Macs; otherwise read from the schedule text and the next run.
    var time: String?
    var days: [Int]?

    init(id: String, name: String, scheduleText: String = "", enabled: Bool = true, nextRun: Date? = nil,
         time: String? = nil, days: [Int]? = nil) {
        self.id = id
        self.name = name
        self.scheduleText = scheduleText
        self.enabled = enabled
        self.nextRun = nextRun
        self.time = time
        self.days = days
    }

    private enum Key: String, CodingKey {
        case id, name, enabled, time, days
        case scheduleText = "schedule_text"
        case nextRun = "next_run"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "routine without an id"))
        }
        self.id = id
        name = c.text(.name) ?? "Routine"
        scheduleText = c.text(.scheduleText) ?? ""
        enabled = c.flag(.enabled) ?? true
        nextRun = c.date(.nextRun)
        time = c.text(.time).flatMap(RoutineSchedule.clock)
        let days = c.list(Int.self, .days).filter { (0...6).contains($0) }
        self.days = days.isEmpty ? nil : Array(Set(days)).sorted()
    }

    /// "HH:MM", from the Mac, else from its schedule ("weekdays at 7 AM"), else from the
    /// next run (none when it's off).
    var clock: String? {
        time ?? RoutineSchedule.timeOfDay(in: scheduleText) ?? nextRun.map { RoutineSchedule.clock(of: $0) }
    }

    /// 0 = Monday … 6 = Sunday, from the Mac or read from the schedule text.
    var weekdays: [Int]? {
        days ?? RoutineSchedule.days(in: scheduleText)
    }
}

struct RoutineList: Equatable, Sendable, Decodable {
    var items: [RoutineItem]

    private enum Key: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        items = c.list(RoutineItem.self, .items)
    }
}

/// Routine times and days as the Mac writes them: "HH:MM", 0 = Monday … 6 = Sunday.
enum RoutineSchedule {
    static let dayLetters = ["M", "T", "W", "T", "F", "S", "S"]
    static let dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    /// A schedule of weekdays at a time, as the Mac describes one ("every day at 7 AM",
    /// "weekdays at 7 AM", "Mondays, Fridays at 4 PM"): the only kind the Mac keeps as it
    /// is when it's given days. (A routine on a trigger, every so often, monthly or once reads
    /// otherwise.)
    static func isDayBased(_ text: String) -> Bool {
        let day = "(?:mon|tues|wednes|thurs|fri|satur|sun)days"
        let pattern = "^(?:every day|daily|weekdays|weekends|\(day)(?:(?:, | and |, and )\(day))*) at "
        return text.trimmed.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// "7:05", "07:05", "7:05:00" → "07:05"; nil for anything else.
    static func clock(_ text: String) -> String? {
        let parts = text.trimmed.split(separator: ":")
        guard parts.count >= 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return String(format: "%02d:%02d", hour, minute)
    }

    static func clock(of date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// The time of day in a schedule as the Mac describes it ("weekdays at 7 AM",
    /// "Mondays, Fridays at 4:30 PM", "daily at 22:30"): "HH:MM", or nil when it names none.
    static func timeOfDay(in text: String) -> String? {
        let pattern = #"\bat (\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?(?![0-9A-Za-z])"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).last else { return nil }
        func group(_ index: Int) -> String? {
            Range(match.range(at: index), in: text).map { String(text[$0]) }
        }
        guard var hour = group(1).flatMap({ Int($0) }) else { return nil }
        let minute = group(2).flatMap { Int($0) } ?? 0
        if let half = group(3)?.lowercased() {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (half == "pm" ? 12 : 0)
        } else if group(2) == nil {
            return nil  // "at 7" alone isn't a time the Mac writes
        }
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return String(format: "%02d:%02d", hour, minute)
    }

    /// Days named in a schedule ("weekdays at 7:00", "Mondays and Fridays at 16:00",
    /// "daily at 7:00"); nil when it names none.
    static func days(in text: String) -> [Int]? {
        let lower = text.lowercased()
        if lower.contains("weekday") { return [0, 1, 2, 3, 4] }
        if lower.contains("weekend") { return [5, 6] }
        if lower.contains("daily") || lower.contains("every day") { return Array(0...6) }
        let found = dayNames.indices.filter { lower.contains(dayNames[$0].lowercased()) }
        return found.isEmpty ? nil : found
    }

    /// The date for an "HH:MM" today, for a time picker.
    static func date(for clock: String, calendar: Calendar = .current, now: Date = Date()) -> Date {
        let parts = clock.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return now }
        return calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: now) ?? now
    }
}

/// The routine editor's decisions: what it starts at, what it may change, and what Save
/// sends (only what changed).
struct RoutineEdit: Equatable {
    struct Change: Equatable {
        var time: String?
        var days: [Int]?

        var isEmpty: Bool { time == nil && days == nil }
    }

    let routine: RoutineItem
    /// What the time picker and the day keys start at: the routine's own.
    let startClock: String
    let startDays: Set<Int>

    init(_ routine: RoutineItem) {
        self.routine = routine
        startClock = routine.clock ?? "08:00"
        startDays = Set(routine.weekdays ?? [])
    }

    /// Days, for a routine that runs on weekdays at a time. Given days, the Mac makes any
    /// routine one of those, so one on a trigger, every so often, monthly or once is
    /// changed on the Mac instead.
    var editsDays: Bool { routine.days != nil || RoutineSchedule.isDayBased(routine.scheduleText) }

    /// A time of day: the day-based ones, a one-off and a monthly one. A routine on a trigger
    /// or every so often has none.
    var editsTime: Bool {
        let text = routine.scheduleText.trimmed.lowercased()
        return routine.time != nil || editsDays || text.hasPrefix("once") || text.hasPrefix("monthly")
    }

    /// Only what the owner changed: a time or days sent unchanged could still change the
    /// routine (a time the phone didn't know).
    func changes(clock: String, days: Set<Int>) -> Change {
        let time = editsTime && clock != startClock ? clock : nil
        let days = editsDays && !days.isEmpty && days != startDays ? days.sorted() : nil
        return Change(time: time, days: days)
    }
}

// MARK: - Pairing

/// POST /api/pair
struct PairResult: Equatable, Sendable, Decodable {
    var token: String
    var fingerprint: String?
    var macName: String?

    private enum Key: String, CodingKey {
        case token, fingerprint
        case macName = "mac_name"
    }

    init(token: String, fingerprint: String?, macName: String?) {
        self.token = token
        self.fingerprint = fingerprint
        self.macName = macName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let token = c.text(.token), !token.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "no token"))
        }
        self.token = token
        fingerprint = c.text(.fingerprint).flatMap(CertificatePin.normalize)
        macName = c.text(.macName).flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
    }
}

// MARK: - Things this device sends

/// POST /api/location
struct LocationReport: Equatable, Sendable {
    enum Event: String, Sendable { case arrive, leave }
    enum Region: String, Sendable, CaseIterable { case home, work }

    var latitude: Double
    var longitude: Double
    var accuracy: Double
    var at: Date
    var event: Event?
    var region: Region?

    var body: JSONValue {
        .object(dropping: [
            "lat": .double(latitude),
            "lon": .double(longitude),
            "accuracy": .double(accuracy.rounded()),
            "at": .int(Int(at.timeIntervalSince1970)),
            "event": event.map { .string($0.rawValue) },
            "region": region.map { .string($0.rawValue) },
        ])
    }
}

/// POST /api/health: one day's summary.
struct HealthDay: Equatable, Sendable {
    struct Workout: Equatable, Sendable {
        var kind: String
        var minutes: Int
    }

    /// "YYYY-MM-DD"
    var day: String
    var steps: Int?
    var sleepHours: Double?
    var restingHeartRate: Int?
    var workouts: [Workout]?

    var body: JSONValue {
        .object(dropping: [
            "day": .string(day),
            "steps": steps.map { .int($0) },
            "sleep_hours": sleepHours.map { .double(($0 * 10).rounded() / 10) },
            "resting_hr": restingHeartRate.map { .int($0) },
            "workouts": workouts.map { list in
                .array(list.map { ["kind": .string($0.kind), "minutes": .int($0.minutes)] })
            },
        ])
    }

    var isEmpty: Bool { steps == nil && sleepHours == nil && restingHeartRate == nil && (workouts ?? []).isEmpty }

    static func key(for date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }
}

/// POST /api/share
struct ShareItem: Equatable, Sendable {
    enum Kind: String, Sendable { case url, text, image, file }

    var kind: Kind
    var url: String?
    var text: String?
    var name: String?
    var data: Data?
    /// What to do with it ("summarize this"), run on the Mac as a silent request.
    var note: String?

    /// The most the Mac takes, as the file itself (companion_api.SHARE_BYTES: 25 MB). Its
    /// body cap (SHARE_BODY) leaves room for the base64 and the other fields.
    static let maxBytes = 25 * 1024 * 1024
    /// The Mac reads this much of a note.
    static let maxNote = 2000

    /// The small fields as JSON; the data (base64) is spliced in by `body()` without
    /// copying it through an encoder.
    var fields: JSONValue {
        .object(dropping: [
            "kind": .string(kind.rawValue),
            "url": url.map { .string($0) },
            "text": text.map { .string($0) },
            "name": name.map { .string($0) },
            "note": note.flatMap { $0.trimmed.isEmpty ? nil : .string(String($0.trimmed.prefix(Self.maxNote))) },
        ])
    }

    func body() throws -> Data {
        let json = try fields.encoded()
        guard let data else { return json }
        return Base64Body.splice(data, into: json)
    }
}

/// A JSON body with a file in it as `data_base64`, written a slice at a time: a 25 MB file
/// never has a whole second copy of itself as base64 beside the body (the share extension
/// has little memory).
enum Base64Body {
    /// {"kind":"file",…} → {"kind":"file",…,"data_base64":"…"}
    static func splice(_ data: Data, into object: Data) -> Data {
        var json = object
        json.removeLast()  // }
        let key = Data((json.count > 1 ? #","data_base64":""# : #""data_base64":""#).utf8)
        json.reserveCapacity(json.count + key.count + (data.count + 2) / 3 * 4 + 2)
        json.append(key)
        let slice = 3 * 256 * 1024  // a multiple of 3: no padding before the end
        var start = data.startIndex
        while start < data.endIndex {
            let end = data.index(start, offsetBy: slice, limitedBy: data.endIndex) ?? data.endIndex
            json.append(data[start..<end].base64EncodedData())
            start = end
        }
        json.append(Data(#""}"#.utf8))
        return json
    }
}

// MARK: - Push payloads

/// The custom `jarvis` key of a push, and what a notification carries for its actions.
struct JarvisPush: Equatable, Sendable {
    enum Kind: String, Sendable {
        case approval
        case codeApproval = "code_approval"
        case headsup
        case codeDone = "code_done"
        case codeNeedsYou = "code_needs_you"
        case delegation, call
        /// A long video summary in progress (not in the contract's first list; accepted so
        /// the Mac can start a video Live Activity).
        case video
        case unknown
    }

    var kind: Kind
    var id: String
    var taskID: Int?
    var choices: [ApprovalChoice]
    var at: Date?
    var title: String
    var body: String

    /// Reads a notification's userInfo; nil when it isn't one of the Mac's.
    init?(userInfo: [AnyHashable: Any]) {
        guard let jarvis = userInfo["jarvis"] as? [String: Any] else { return nil }
        kind = Kind(rawValue: (jarvis["kind"] as? String ?? "").lowercased()) ?? .unknown
        id = Self.text(jarvis["id"]) ?? ""
        taskID = Self.integer(jarvis["task_id"])
        choices = (jarvis["choices"] as? [[String: Any]] ?? []).compactMap { raw in
            guard let id = Self.text(raw["id"]), !id.isEmpty else { return nil }
            return ApprovalChoice(id: id, label: Self.text(raw["label"]) ?? id.capitalized)
        }
        at = (jarvis["at"] as? Double).flatMap(LooseDate.epoch) ?? Self.integer(jarvis["at"]).flatMap { LooseDate.epoch(Double($0)) }
        let alert = (userInfo["aps"] as? [String: Any])?["alert"]
        if let alert = alert as? [String: Any] {
            title = alert["title"] as? String ?? ""
            body = alert["body"] as? String ?? ""
        } else {
            title = ""
            body = alert as? String ?? ""
        }
    }

    init(kind: Kind, id: String, taskID: Int? = nil, choices: [ApprovalChoice] = [], at: Date? = nil, title: String = "", body: String = "") {
        self.kind = kind
        self.id = id
        self.taskID = taskID
        self.choices = choices
        self.at = at
        self.title = title
        self.body = body
    }

    var isApproval: Bool { kind == .approval || kind == .codeApproval }

    private static func text(_ value: Any?) -> String? {
        switch value {
        case let text as String: return text
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }

    private static func integer(_ value: Any?) -> Int? {
        switch value {
        case let number as NSNumber:
            let double = number.doubleValue
            return double.isFinite && abs(double) < 9e15 ? Int(double) : nil
        case let text as String: return Int(text)
        default: return nil
        }
    }
}
