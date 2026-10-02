import Foundation

// The companion API's JSON, decoded leniently: a missing or oddly typed field falls back
// to a default instead of failing the whole response, and a bad list item is skipped.

enum MacState: String, Equatable, Sendable {
    case idle, listening, thinking, speaking, unknown

    var label: String {
        switch self {
        case .idle: "Idle"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .unknown: "Connecting"
        }
    }

    /// Working on a turn (listening means the Mac is hearing someone out).
    var isBusy: Bool { self == .thinking || self == .speaking || self == .listening }
}

extension MacState: Decodable {
    init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = MacState(rawValue: raw ?? "") ?? .unknown
    }
}

struct Turn: Equatable, Sendable, Decodable {
    var user = ""
    var reply = ""

    init(user: String = "", reply: String = "") {
        self.user = user
        self.reply = reply
    }

    private enum Key: String, CodingKey { case user, reply }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        user = c.text(.user) ?? ""
        reply = c.text(.reply) ?? ""
    }
}

struct ApprovalChoice: Identifiable, Hashable, Sendable, Decodable {
    var id: String
    var label: String

    init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    private enum Key: String, CodingKey { case id, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "choice without an id"))
        }
        self.id = id
        label = c.text(.label) ?? id.capitalized
    }

    /// "Deny", "Don't send", "Not now": the answer that says no.
    var isNegative: Bool {
        let id = id.lowercased()
        if ["deny", "no", "cancel", "reject", "never", "stop"].contains(id) { return true }
        let label = label.lowercased().replacingOccurrences(of: "’", with: "'")
        if label == "no" { return true }
        return ["deny", "don't", "do not", "not now", "cancel", "never", "stop", "reject"]
            .contains { label.hasPrefix($0) }
    }
}

struct Approval: Identifiable, Equatable, Sendable, Decodable {
    /// Who is asking: JARVIS itself, or a Jarvis Code session.
    enum Source: String, Equatable, Sendable {
        case jarvis, code
    }

    var id: String
    var question: String
    var detail: String
    var choices: [ApprovalChoice]
    var source: Source = .jarvis
    /// The Jarvis Code session it's for.
    var taskID: Int?
    /// "question": a Claude question, answered with an option (opt<N>), several ("pick") or
    /// the owner's own words ("other"), as freeChoices allows.
    var askKind = ""
    var multi = false
    var options: [ApprovalOption] = []
    var freeChoices: [String] = []

    var isQuestion: Bool { askKind == "question" }

    static let defaultChoices = [
        ApprovalChoice(id: "allow", label: "Allow"),
        ApprovalChoice(id: "deny", label: "Not now"),
    ]

    init(
        id: String, question: String, detail: String = "", choices: [ApprovalChoice] = Approval.defaultChoices,
        source: Source = .jarvis, taskID: Int? = nil
    ) {
        self.id = id
        self.question = question
        self.detail = detail
        self.choices = choices.isEmpty ? Approval.defaultChoices : choices
        self.source = source
        self.taskID = taskID
    }

    private enum Key: String, CodingKey {
        case id, question, detail, choices, source, multi, options
        case taskID = "task_id"
        case askKind = "ask_kind"
        case freeChoices = "free_choices"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "approval without an id"))
        }
        let taskID = c.integer(.taskID)
        self.init(
            id: id,
            question: c.text(.question) ?? "Jarvis needs your OK.",
            detail: c.text(.detail) ?? "",
            choices: c.list(ApprovalChoice.self, .choices),
            // An older Mac doesn't say; a card tied to a session is Jarvis Code's.
            source: Source(rawValue: c.text(.source) ?? "") ?? (taskID == nil ? .jarvis : .code),
            taskID: taskID
        )
        askKind = c.text(.askKind) ?? ""
        multi = c.flag(.multi) ?? false
        options = c.list(ApprovalOption.self, .options)
        freeChoices = ((try? c.decodeIfPresent([String].self, forKey: .freeChoices)) ?? nil) ?? []
    }

    /// The yes: the first choice, the one the Mac offers first.
    var primary: ApprovalChoice { choices.first ?? Approval.defaultChoices[0] }
    /// The no: the last choice (what the Mac picks when nobody answers).
    var negative: ApprovalChoice { choices.last ?? Approval.defaultChoices[1] }
}

/// One option of a Claude question.
struct ApprovalOption: Equatable, Sendable, Decodable {
    var label: String
    var description: String

    init(label: String, description: String = "") {
        self.label = label
        self.description = description
    }

    private enum Key: String, CodingKey { case label, description }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        label = c.text(.label) ?? ""
        description = c.text(.description) ?? ""
    }
}

struct HistoryItem: Equatable, Sendable, Decodable {
    enum Role: String, Sendable { case user, assistant, other }

    var role: Role
    var text: String
    var at: String

    init(role: Role, text: String, at: String = "") {
        self.role = role
        self.text = text
        self.at = at
    }

    private enum Key: String, CodingKey { case role, text, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        role = Role(rawValue: c.text(.role) ?? "") ?? .other
        text = c.text(.text) ?? ""
        at = c.text(.at) ?? ""
    }

    /// Identifies an entry across polls (the Mac sends the last twelve).
    var key: String { "\(role.rawValue)|\(at)|\(text)" }
    var date: Date? { LooseDate.parse(at) }
}

struct Weather: Equatable, Sendable, Decodable {
    var city = ""
    var summary = ""
    var unit = "°"
    var temp: Double?
    var high: Double?
    var low: Double?
    var code: Int?
    var error: String?

    init() {}

    private enum Key: String, CodingKey { case city, summary, unit, temp, high, low, code, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        city = c.text(.city) ?? ""
        summary = c.text(.summary) ?? ""
        unit = c.text(.unit) ?? "°"
        temp = c.number(.temp)
        high = c.number(.high)
        low = c.number(.low)
        code = c.integer(.code)
        error = c.text(.error)
    }

    var isAvailable: Bool { error == nil && temp != nil }

    /// "18°C · Mainly clear"
    var headline: String {
        guard let temp else { return summary.capitalizedFirst }
        let degrees = "\(Int(temp.rounded()))\(unit)"
        return summary.isEmpty ? degrees : "\(degrees) · \(summary.capitalizedFirst)"
    }

    /// An SF Symbol for the WMO weather code.
    var symbol: String {
        switch code ?? -1 {
        case 0, 1: "sun.max.fill"
        case 2: "cloud.sun.fill"
        case 3: "cloud.fill"
        case 45, 48: "cloud.fog.fill"
        case 51...57: "cloud.drizzle.fill"
        case 61...67, 80...82: "cloud.rain.fill"
        case 71...77, 85, 86: "cloud.snow.fill"
        case 95...99: "cloud.bolt.rain.fill"
        default: "thermometer.medium"
        }
    }
}

struct NextEvent: Equatable, Sendable, Decodable {
    var title: String
    var begin: String
    var location: String

    private enum Key: String, CodingKey { case title, begin, location }

    init(title: String, begin: String, location: String = "") {
        self.title = title
        self.begin = begin
        self.location = location
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        title = c.text(.title) ?? "Event"
        begin = c.text(.begin) ?? ""
        location = c.text(.location) ?? ""
    }

    var date: Date? { LooseDate.parse(begin) }
}

struct BackgroundTask: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var label: String
    var title: String
    var status: String
    var lastAction: String

    private enum Key: String, CodingKey {
        case id, label, title, status
        case lastAction = "last_action"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = c.text(.id) ?? UUID().uuidString
        label = c.text(.label) ?? ""
        title = c.text(.title) ?? ""
        status = c.text(.status) ?? ""
        lastAction = c.text(.lastAction) ?? ""
    }

    /// Running now. ("waiting" is a Jarvis Code session whose turn is over, waiting for the
    /// next message: idle, however long it stays open.)
    var isActive: Bool { status == "running" }
}

struct Routine: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var name: String

    private enum Key: String, CodingKey { case id, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "routine without an id"))
        }
        self.id = id
        name = c.text(.name) ?? "Routine"
    }
}

/// GET /api/state
struct RemoteState: Equatable, Sendable, Decodable {
    /// Whether the Mac sends pushes to this device.
    struct Push: Equatable, Sendable, Decodable {
        var enabled = false
        var registered = false

        init(enabled: Bool = false, registered: Bool = false) {
            self.enabled = enabled
            self.registered = registered
        }

        private enum Key: String, CodingKey { case enabled, registered }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            enabled = c.flag(.enabled) ?? false
            registered = c.flag(.registered) ?? false
        }
    }

    var state: MacState = .unknown
    var turn = Turn()
    var approvals: [Approval] = []
    var history: [HistoryItem] = []
    var weather: Weather?
    var nextEvent: NextEvent?
    var tasks: [BackgroundTask] = []
    var meeting: String?
    var routines: [Routine] = []
    var model: String?
    /// Approvals waiting, everywhere (the list may be shorter).
    var pendingApprovals = 0
    var codeSessions: [CodeSessionSummary] = []
    var delegationsActive = 0
    var push: Push?
    var tls = false
    /// The Mac's feature screens it serves (memory, goals, timers…).
    var features: [String] = []
    /// What the Mac asks of this iPhone's contacts and calendar (only those turned on).
    var phoneAsks: [PhoneAsk] = []
    /// The Mac's device id in the owner's Jarvis account, once it's linked (for the relay).
    var accountDeviceID: String?

    init() {}

    /// `"account": {"device_id": "…"}`, only once the Mac is linked to an account.
    private struct AccountLink: Decodable {
        var deviceID: String?
        private enum Key: String, CodingKey { case deviceID = "device_id" }
        init(from decoder: Decoder) throws {
            deviceID = try decoder.container(keyedBy: Key.self).text(.deviceID)?.trimmed
        }
    }

    private enum Key: String, CodingKey {
        case state, turn, approvals, history, weather, tasks, meeting, routines, model, push, tls, features
        case nextEvent = "next_event"
        case pendingApprovals = "pending_approvals"
        case codeSessions = "code_sessions"
        case delegationsActive = "delegations_active"
        case phoneAsks = "phone_asks"
        case account
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        state = c.object(MacState.self, .state) ?? .unknown
        turn = c.object(Turn.self, .turn) ?? Turn()
        approvals = c.list(Approval.self, .approvals)
        history = c.list(HistoryItem.self, .history)
        weather = c.object(Weather.self, .weather)
        nextEvent = c.object(NextEvent.self, .nextEvent)
        tasks = c.list(BackgroundTask.self, .tasks)
        meeting = c.text(.meeting).flatMap { $0.isEmpty ? nil : $0 }
        routines = c.list(Routine.self, .routines)
        model = c.text(.model)
        pendingApprovals = max(c.integer(.pendingApprovals) ?? 0, approvals.count)
        codeSessions = c.list(CodeSessionSummary.self, .codeSessions)
        delegationsActive = max(0, c.integer(.delegationsActive) ?? 0)
        push = c.object(Push.self, .push)
        tls = c.flag(.tls) ?? false
        features = ((try? c.decodeIfPresent([String].self, forKey: .features)) ?? nil) ?? []
        phoneAsks = c.list(PhoneAsk.self, .phoneAsks).filter { !$0.id.isEmpty && $0.kind != .unknown }
        accountDeviceID = c.object(AccountLink.self, .account)?.deviceID.flatMap { $0.isEmpty ? nil : $0 }
    }

    var activeTasks: [BackgroundTask] { tasks.filter(\.isActive) }
    /// Jarvis Code sessions working or waiting on the owner.
    var liveCodeSessions: [CodeSessionSummary] { codeSessions.filter(\.status.isLive) }
}

/// POST /api/ask
struct AskResult: Equatable, Sendable, Decodable {
    var reply: String
    var done: Bool
    var approvals: [Approval]

    init(reply: String, done: Bool, approvals: [Approval] = []) {
        self.reply = reply
        self.done = done
        self.approvals = approvals
    }

    private enum Key: String, CodingKey { case reply, done, approvals }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        reply = c.text(.reply) ?? ""
        done = c.flag(.done) ?? true
        approvals = c.list(Approval.self, .approvals)
    }
}

/// POST /api/command
enum MacCommand: Equatable, Sendable {
    case stop
    case briefing
    case meetingStart(title: String)
    case meetingStop
    case runRoutine(id: String)

    var json: JSONValue {
        switch self {
        case .stop: ["type": "stop"]
        case .briefing: ["type": "briefing"]
        case .meetingStart(let title): ["type": "meeting_start", "title": .string(title)]
        case .meetingStop: ["type": "meeting_stop"]
        case .runRoutine(let id): ["type": "routine_run", "id": .string(id)]
        }
    }

    /// Worth sending an hour late if the Mac can't be reached now; stopping and meeting
    /// notes only mean something at the moment they're asked for.
    var keepsWhenOffline: Bool {
        switch self {
        case .briefing, .runRoutine: true
        case .stop, .meetingStart, .meetingStop: false
        }
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
