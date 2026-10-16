import Foundation

// What the Mac's /api/code/phone/* calls answer (docs/eden-code-phone.md), read as leniently
// as the rest of the companion API (Shared/Decoding.swift): a field that goes missing or
// changes type falls back, a list item that doesn't decode is skipped.

/// A session in the list: `{id, title, project, status, mode, mode_label, model, cost_usd, updated_at}`.
struct PhoneSummary: Identifiable, Equatable, Hashable, Sendable, Decodable {
    var id: Int
    var title: String
    var project: String
    var status: CodeStatus
    var mode: String
    var modeLabel: String
    var model: String
    var costUSD: Double
    var updatedAt: Date?

    init(id: Int, title: String, project: String, status: CodeStatus, mode: String = "ask", modeLabel: String = "Manual",
         model: String = "", costUSD: Double = 0, updatedAt: Date? = nil) {
        self.id = id
        self.title = title
        self.project = project
        self.status = status
        self.mode = mode
        self.modeLabel = modeLabel
        self.model = model
        self.costUSD = costUSD
        self.updatedAt = updatedAt
    }

    private enum Key: String, CodingKey {
        case id, title, project, status, mode, model
        case modeLabel = "mode_label"
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
        title = c.text(.title).flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? (project.isEmpty ? "Eden Code" : project)
        status = c.object(CodeStatus.self, .status) ?? .unknown
        mode = c.text(.mode) ?? ""
        modeLabel = c.text(.modeLabel) ?? CodeModes.name(mode)
        model = c.text(.model) ?? ""
        costUSD = c.number(.costUSD) ?? 0
        updatedAt = c.date(.updatedAt)
    }
}

/// A card that waits on the owner: the companion's Approval, and what the phone may do with it.
struct PhoneCard: Identifiable, Equatable, Sendable, Decodable {
    var approval: Approval
    /// Only its "no" is taken from the phone (Touch ID on the Mac, a risky step's, a tap-only one).
    var macOnly: Bool
    /// Face ID before a yes on the iPhone (a command to run, an "always allow").
    var faceID: Bool
    /// The tool it's for ("Bash", "Edit"…), when the Mac says.
    var tool: String
    /// The isolated copy's slug, for a Land or Discard card the phone put up.
    var copy: String?

    var id: String { approval.id }
    var taskID: Int? { approval.taskID }

    init(approval: Approval, macOnly: Bool = false, faceID: Bool = false, tool: String = "", copy: String? = nil) {
        self.approval = approval
        self.macOnly = macOnly
        self.faceID = faceID
        self.tool = tool
        self.copy = copy
    }

    private enum Key: String, CodingKey {
        case tool, copy
        case macOnly = "mac_only"
        case faceID = "face_id"
    }

    init(from decoder: Decoder) throws {
        approval = try Approval(from: decoder)
        let c = try decoder.container(keyedBy: Key.self)
        macOnly = c.flag(.macOnly) ?? false
        tool = c.text(.tool) ?? ""
        faceID = c.flag(.faceID) ?? (tool == "Bash")
        copy = c.text(.copy).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The answers that say yes (every choice but the negative ones).
    var yesChoices: [ApprovalChoice] { approval.choices.filter { !$0.isNegative } }
    /// The no.
    var noChoice: ApprovalChoice { approval.choices.first(where: \.isNegative) ?? ApprovalChoice(id: "deny", label: "Deny") }
    /// A yes that allows from now on ("Always allow migrations in this project").
    func isStanding(_ choice: ApprovalChoice) -> Bool {
        "\(choice.id) \(choice.label)".lowercased().contains("always")
    }
    /// Face ID before this answer.
    func needsFaceID(_ choice: ApprovalChoice) -> Bool {
        !choice.isNegative && (faceID || isStanding(choice))
    }
}

/// An Exterminator Mode run.
struct PhoneRun: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var project: String
    var state: String
    var round: Int
    var rounds: Int
    var step: String
    var spent: Double
    var spendCap: Double
    var taskID: Int?
    var found: Int
    var fixed: Int

    private enum Key: String, CodingKey {
        case id, project, state, round, rounds, step, spent, found, fixed
        case spendCap = "spend_cap"
        case taskID = "task_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = c.text(.id) ?? UUID().uuidString
        project = c.text(.project) ?? ""
        state = c.text(.state) ?? ""
        round = c.integer(.round) ?? 0
        rounds = c.integer(.rounds) ?? 0
        step = c.text(.step) ?? ""
        spent = c.number(.spent) ?? 0
        spendCap = c.number(.spendCap) ?? 0
        taskID = c.integer(.taskID)
        found = c.integer(.found) ?? 0
        fixed = c.integer(.fixed) ?? 0
    }

    /// "Round 2 of 3 · fix · 4 found, 1 fixed · $1.50 of $10.00"
    var line: String {
        var parts: [String] = []
        if rounds > 0 { parts.append("Round \(round) of \(rounds)") }
        if !step.isEmpty { parts.append(step) }
        parts.append("\(found) found, \(fixed) fixed")
        if spendCap > 0 { parts.append("\(Money.text(spent)) of \(Money.text(spendCap))") }
        return parts.joined(separator: " · ")
    }
}

/// GET /home.
struct PhoneHome: Equatable, Sendable, Decodable {
    struct Pinned: Equatable, Sendable, Decodable {
        var id: Int
        var title: String
        /// Epoch milliseconds.
        var at: Double

        private enum Key: String, CodingKey { case id, title, at }

        init(id: Int, title: String, at: Double) {
            self.id = id
            self.title = title
            self.at = at
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let id = c.integer(.id) else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "pin without an id"))
            }
            self.id = id
            title = c.text(.title) ?? ""
            at = c.number(.at) ?? 0
        }
    }

    var sessions: [PhoneSummary] = []
    var attention: [PhoneCard] = []
    var pinned: Pinned?
    var exterminator: [PhoneRun] = []

    init(sessions: [PhoneSummary] = [], attention: [PhoneCard] = [], pinned: Pinned? = nil, exterminator: [PhoneRun] = []) {
        self.sessions = sessions
        self.attention = attention
        self.pinned = pinned
        self.exterminator = exterminator
    }

    private enum Key: String, CodingKey { case sessions, attention, pinned, exterminator }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        sessions = c.list(PhoneSummary.self, .sessions)
        attention = c.list(PhoneCard.self, .attention)
        pinned = c.object(Pinned.self, .pinned)
        exterminator = c.list(PhoneRun.self, .exterminator)
    }

    /// Sessions by project, in the order their newest session comes.
    var byProject: [(project: String, sessions: [PhoneSummary])] {
        var order: [String] = []
        var groups: [String: [PhoneSummary]] = [:]
        for session in sessions {
            let key = session.project.isEmpty ? "Other" : session.project
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(session)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    var needsYouCount: Int { max(attention.count, sessions.filter { $0.status == .needsYou }.count) }
}

/// GET /options.
struct PhoneOptions: Equatable, Sendable, Decodable {
    struct Model: Identifiable, Equatable, Hashable, Sendable, Decodable {
        var ref: String
        var name: String
        var group: String
        var needsKey: Bool
        var id: String { ref }

        init(ref: String, name: String, group: String = "", needsKey: Bool = false) {
            self.ref = ref
            self.name = name
            self.group = group
            self.needsKey = needsKey
        }

        private enum Key: String, CodingKey {
            case ref, name, group
            case needsKey = "needs_key"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let ref = c.text(.ref), !ref.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "model without a ref"))
            }
            self.ref = ref
            name = c.text(.name) ?? ref
            group = c.text(.group) ?? ""
            needsKey = c.flag(.needsKey) ?? false
        }
    }

    struct Mode: Identifiable, Equatable, Hashable, Sendable, Decodable {
        var id: String
        var name: String

        init(id: String, name: String) {
            self.id = id
            self.name = name
        }

        private enum Key: String, CodingKey { case id, name }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let id = c.text(.id), !id.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "mode without an id"))
            }
            self.id = id
            name = c.text(.name) ?? CodeModes.name(id)
        }
    }

    struct Project: Identifiable, Equatable, Hashable, Sendable, Decodable {
        var name: String
        var branch: String
        var running: Int
        var id: String { name }

        init(name: String, branch: String = "", running: Int = 0) {
            self.name = name
            self.branch = branch
            self.running = running
        }

        private enum Key: String, CodingKey { case name, branch, running }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let name = c.text(.name), !name.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "project without a name"))
            }
            self.name = name
            branch = c.text(.branch) ?? ""
            running = c.integer(.running) ?? 0
        }
    }

    var models: [Model] = []
    var modes: [Mode] = CodeModes.phone
    var projects: [Project] = []
    var defaultModel = ""
    var defaultMode = "ask"

    init(models: [Model] = [], modes: [Mode] = CodeModes.phone, projects: [Project] = [], defaultModel: String = "", defaultMode: String = "ask") {
        self.models = models
        self.modes = modes
        self.projects = projects
        self.defaultModel = defaultModel
        self.defaultMode = defaultMode
    }

    private enum Key: String, CodingKey { case models, modes, projects, defaults }
    private enum DefaultsKey: String, CodingKey { case model, mode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        models = c.list(Model.self, .models)
        let modes = c.list(Mode.self, .modes)
        self.modes = modes.isEmpty ? CodeModes.phone : modes
        projects = c.list(Project.self, .projects)
        if let d = try? c.nestedContainer(keyedBy: DefaultsKey.self, forKey: .defaults) {
            defaultModel = d.text(.model) ?? ""
            defaultMode = d.text(.mode) ?? "ask"
        }
    }

    func modelName(_ ref: String) -> String {
        models.first(where: { $0.ref == ref })?.name ?? ref
    }
}

/// The permission modes, as the Mac names them, and the two a phone may pick.
enum CodeModes {
    static let phone = [PhoneOptions.Mode(id: "ask", name: "Manual"), PhoneOptions.Mode(id: "edits", name: "Accept edits")]

    static func name(_ id: String) -> String {
        switch id {
        case "plan": "Plan"
        case "ask": "Manual"
        case "edits": "Accept edits"
        case "smart": "Auto"
        case "auto": "Bypass permissions"
        default: id
        }
    }

    static func symbol(_ id: String) -> String {
        switch id {
        case "plan": "list.bullet.clipboard"
        case "edits": "pencil.line"
        case "smart": "sparkles"
        case "auto": "exclamationmark.shield"
        default: "hand.raised"
        }
    }
}

/// One transcript entry: `{i, role: user | assistant | tool | note, text, at}`.
struct PhoneEntry: Identifiable, Equatable, Sendable, Decodable {
    enum Role: String, Sendable {
        case user, assistant, tool, note
    }

    var i: Int
    var role: Role
    var text: String
    var at: Date?
    var id: Int { i }

    init(i: Int, role: Role, text: String, at: Date? = nil) {
        self.i = i
        self.role = role
        self.text = text
        self.at = at
    }

    private enum Key: String, CodingKey { case i, role, text, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let i = c.integer(.i) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "entry without i"))
        }
        self.i = i
        role = Role(rawValue: (c.text(.role) ?? "").lowercased()) ?? .note
        text = c.text(.text) ?? ""
        at = c.date(.at)
    }

    /// A step's line: "✓ Read file", or "◌ Running tests" while it runs. The Mac sums a step
    /// up as its first line ("Read share.js", "Bash npm test → 41 passed").
    var stepLine: String {
        text.split(separator: "\n", maxSplits: 1).first.map(String.init)?.trimmed ?? text
    }

    var stepFailed: Bool {
        let lower = text.lowercased()
        return lower.contains("error") && (lower.contains("✗") || lower.hasPrefix("failed") || lower.contains(" failed"))
    }

    var stepRunning: Bool { text.lowercased().contains("running…") || text.hasSuffix("…") }
}

/// GET /session: the live view of one session.
struct PhoneView: Equatable, Sendable, Decodable {
    struct Todo: Equatable, Hashable, Sendable, Decodable {
        var text: String
        var done: Bool
        private enum Key: String, CodingKey { case text, done }

        init(text: String, done: Bool) {
            self.text = text
            self.done = done
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            text = c.text(.text) ?? ""
            done = c.flag(.done) ?? false
        }
    }

    struct Copy: Equatable, Sendable, Decodable {
        var branch: String
        var into: String
        var busy: Bool
        private enum Key: String, CodingKey { case branch, into, busy }

        init(branch: String, into: String, busy: Bool) {
            self.branch = branch
            self.into = into
            self.busy = busy
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            branch = c.text(.branch) ?? ""
            into = c.text(.into) ?? ""
            busy = c.flag(.busy) ?? false
        }
    }

    var id: Int
    var title = ""
    var project = ""
    var status: CodeStatus = .unknown
    var doing = ""
    var mode = "ask"
    var modeLabel = "Manual"
    var model = ""
    var modelLabel = ""
    var live = ""
    var todos: [Todo] = []
    var cards: [PhoneCard] = []
    var copy: Copy?
    var next = 0
    var seen = 0
    var v = ""
    var entries: [PhoneEntry] = []
    var changed: [PhoneEntry] = []
    var more = false

    init(id: Int) { self.id = id }

    private enum Key: String, CodingKey {
        case id, title, project, status, doing, mode, model, live, todos, cards, copy, next, seen, v, entries, changed, more
        case modeLabel = "mode_label"
        case modelLabel = "model_label"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.integer(.id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "view without an id"))
        }
        self.id = id
        title = c.text(.title) ?? ""
        project = c.text(.project) ?? ""
        status = c.object(CodeStatus.self, .status) ?? .unknown
        doing = c.text(.doing) ?? ""
        mode = c.text(.mode) ?? "ask"
        modeLabel = c.text(.modeLabel) ?? CodeModes.name(mode)
        model = c.text(.model) ?? ""
        modelLabel = c.text(.modelLabel) ?? model
        live = c.text(.live) ?? ""
        todos = c.list(Todo.self, .todos)
        cards = c.list(PhoneCard.self, .cards)
        copy = c.object(Copy.self, .copy)
        next = c.integer(.next) ?? 0
        seen = c.integer(.seen) ?? 0
        v = c.text(.v) ?? ""
        entries = c.list(PhoneEntry.self, .entries)
        changed = c.list(PhoneEntry.self, .changed)
        more = c.flag(.more) ?? false
    }
}

/// GET /changes: the Changes pane's payload (code_hunks.payload).
struct PhoneChanges: Equatable, Sendable, Decodable {
    struct Hunk: Identifiable, Equatable, Sendable, Decodable {
        var id: String
        var n: Int
        var newStart: Int
        var oldStart: Int
        var header: String
        var lines: [Line]
        var kept: Bool
        var cut: Int

        init(id: String, n: Int, newStart: Int = 1, oldStart: Int = 1, header: String = "", lines: [Line], kept: Bool = false, cut: Int = 0) {
            self.id = id
            self.n = n
            self.newStart = newStart
            self.oldStart = oldStart
            self.header = header
            self.lines = lines
            self.kept = kept
            self.cut = cut
        }

        private enum Key: String, CodingKey {
            case id, n, header, lines, kept, cut
            case newStart = "new_start"
            case oldStart = "old_start"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let id = c.text(.id), !id.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "hunk without an id"))
            }
            self.id = id
            n = c.integer(.n) ?? 0
            newStart = c.integer(.newStart) ?? 1
            oldStart = c.integer(.oldStart) ?? 1
            header = c.text(.header) ?? ""
            kept = c.flag(.kept) ?? false
            cut = c.integer(.cut) ?? 0
            let raw = ((try? c.decodeIfPresent([[String]].self, forKey: .lines)) ?? nil) ?? []
            lines = Line.number(raw, oldStart: oldStart, newStart: newStart)
        }
    }

    /// One line of a hunk, with the line number it has in the file (new for kept and added
    /// lines, old for removed ones): where a comment goes.
    struct Line: Identifiable, Equatable, Hashable, Sendable {
        enum Kind: Sendable { case added, removed, context }
        var index: Int
        var kind: Kind
        var text: String
        var number: Int
        var id: Int { index }

        static func number(_ raw: [[String]], oldStart: Int, newStart: Int) -> [Line] {
            var old = oldStart
            var new = newStart
            var out: [Line] = []
            for (index, pair) in raw.enumerated() {
                guard let tag = pair.first else { continue }
                let text = pair.count > 1 ? pair[1] : ""
                switch tag {
                case "+":
                    out.append(Line(index: index, kind: .added, text: text, number: new))
                    new += 1
                case "-":
                    out.append(Line(index: index, kind: .removed, text: text, number: old))
                    old += 1
                case "\\":
                    continue
                default:
                    out.append(Line(index: index, kind: .context, text: text, number: new))
                    old += 1
                    new += 1
                }
            }
            return out
        }
    }

    struct File: Identifiable, Equatable, Sendable, Decodable {
        var path: String
        var status: String
        var binary: Bool
        var sensitive: Bool
        var added: Int
        var removed: Int
        var omitted: Bool
        var hunks: [Hunk]
        var id: String { path }

        init(path: String, status: String = "M", added: Int, removed: Int, hunks: [Hunk], binary: Bool = false, sensitive: Bool = false, omitted: Bool = false) {
            self.path = path
            self.status = status
            self.added = added
            self.removed = removed
            self.hunks = hunks
            self.binary = binary
            self.sensitive = sensitive
            self.omitted = omitted
        }

        private enum Key: String, CodingKey { case path, status, binary, sensitive, added, removed, omitted, hunks }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            guard let path = c.text(.path), !path.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "file without a path"))
            }
            self.path = path
            status = c.text(.status) ?? ""
            binary = c.flag(.binary) ?? false
            sensitive = c.flag(.sensitive) ?? false
            added = c.integer(.added) ?? 0
            removed = c.integer(.removed) ?? 0
            omitted = c.flag(.omitted) ?? false
            hunks = c.list(Hunk.self, .hunks)
        }
    }

    var id: Int
    var view = "session"
    var git = true
    var files: [File] = []
    var totalFiles = 0
    var totalHunks = 0

    init(id: Int, view: String = "session", files: [File]) {
        self.id = id
        self.view = view
        self.files = files
        totalFiles = files.count
        totalHunks = files.reduce(0) { $0 + $1.hunks.count }
    }

    private enum Key: String, CodingKey { case id, view, git, files, totals }
    private enum TotalsKey: String, CodingKey { case files, hunks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = c.integer(.id) ?? 0
        view = c.text(.view) ?? "session"
        git = c.flag(.git) ?? true
        files = c.list(File.self, .files)
        if let t = try? c.nestedContainer(keyedBy: TotalsKey.self, forKey: .totals) {
            totalFiles = t.integer(.files) ?? files.count
            totalHunks = t.integer(.hunks) ?? files.reduce(0) { $0 + $1.hunks.count }
        } else {
            totalFiles = files.count
            totalHunks = files.reduce(0) { $0 + $1.hunks.count }
        }
    }

    /// Every hunk not yet kept: what Undo all puts back.
    var unkeptHunks: [String] { files.flatMap(\.hunks).filter { !$0.kept }.map(\.id) }
}

/// POST /hunk's answer.
struct PhoneHunkResult: Equatable, Sendable, Decodable {
    var ok: Bool
    var said: String
    var changes: PhoneChanges?

    private enum Key: String, CodingKey { case ok, said, changes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        ok = c.flag(.ok) ?? false
        said = c.text(.said) ?? ""
        changes = c.object(PhoneChanges.self, .changes)
    }
}

/// A line comment, as the window's Changes pane sends them.
struct PhoneComment: Equatable, Sendable {
    var path: String
    var line: Int
    /// "o" for a removed line.
    var side: String?
    var excerpt: String
    var text: String

    var json: JSONValue {
        .object(dropping: ["path": .string(path), "line": .int(line), "side": side.map { .string($0) },
                           "excerpt": .string(String(excerpt.prefix(300))), "text": .string(text)])
    }
}

/// One turn's receipt (code_receipts): the proof card's parts the phone shows.
struct PhoneReceipt: Identifiable, Equatable, Sendable, Decodable {
    struct Row: Equatable, Hashable, Sendable {
        enum Mark: Sendable { case good, warn, bad }
        var mark: Mark
        var text: String
    }

    var i: Int
    var text: String
    var risk: String
    var why: String
    var fileCount: Int
    var rows: [Row]
    var id: Int { i }

    init(i: Int, text: String = "", risk: String, why: String, fileCount: Int, rows: [Row]) {
        self.i = i
        self.text = text
        self.risk = risk
        self.why = why
        self.fileCount = fileCount
        self.rows = rows
    }

    private enum Key: String, CodingKey { case i, text, receipt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        i = c.integer(.i) ?? 0
        text = c.text(.text) ?? ""
        let r = c.object(JSONValue.self, .receipt) ?? [:]
        risk = r["risk"]?.stringValue ?? "low"
        why = r["why"]?.stringValue ?? ""
        fileCount = r["file_count"]?.intValue ?? (r["files"]?.arrayValue?.count ?? 0)
        rows = Self.rows(r)
    }

    /// The grid: tests, test integrity, the check, its own check, security, guardrails,
    /// assumptions, requirements, in that order, each only when the receipt has it.
    static func rows(_ r: JSONValue) -> [Row] {
        var rows: [Row] = []
        if let t = r["tests"], t != .null {
            let state = t["state"]?.stringValue ?? ""
            let passed = t["passed_count"]?.intValue ?? 0
            let failed = t["failed_count"]?.intValue ?? 0
            switch state {
            case "passed": rows.append(Row(mark: .good, text: passed > 0 ? "\(passed) tests passed" : "Tests passed"))
            case "failed": rows.append(Row(mark: .bad, text: failed > 0 ? "\(failed) tests failed" : "Tests failed"))
            case "stale": rows.append(Row(mark: .warn, text: "Tests ran before its last edits"))
            case "cancelled": rows.append(Row(mark: .warn, text: "Tests didn’t finish"))
            case "refused": rows.append(Row(mark: .warn, text: "Tests not run"))
            default: rows.append(Row(mark: .warn, text: "Tests ran"))
            }
        } else {
            rows.append(Row(mark: .warn, text: "No tests run"))
        }
        if let lines = r["integrity"]?["lines"]?.arrayValue, let first = lines.first?["text"]?.stringValue, !first.isEmpty {
            let weakened = r["tests"]?["trusted"]?.boolValue == false
            rows.append(Row(mark: weakened ? .bad : .good, text: first))
        }
        if let check = r["check"], check != .null {
            let problems = check["status"]?.stringValue == "problems"
            rows.append(Row(mark: problems ? .bad : .good, text: problems ? "Check found problems" : "Checked after the turn"))
        }
        if let own = r["selfcheck"], own != .null {
            let verdict = own["verdict"]?.stringValue ?? ""
            rows.append(Row(mark: verdict == "pass" ? .good : verdict == "fail" ? .bad : .warn,
                            text: own["headline"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Checked itself"))
        }
        if let security = r["security"], security != .null {
            let found = security["findings"]?.arrayValue?.count ?? security["found"]?.intValue ?? 0
            rows.append(Row(mark: found == 0 ? .good : .bad, text: found == 0 ? "Security scan clean" : "\(found) security finding\(found == 1 ? "" : "s")"))
        }
        if let guards = r["guardrails"]?.arrayValue, !guards.isEmpty {
            let blocked = guards.filter { $0["action"]?.stringValue == "blocked" }.count
            rows.append(Row(mark: blocked > 0 ? .warn : .good, text: blocked > 0 ? "Guardrails blocked \(blocked)" : "Guardrails held"))
        }
        if let guessed = r["assumptions"]?.arrayValue, !guessed.isEmpty {
            let high = guessed.filter { $0["risk"]?.stringValue == "high" }.count
            rows.append(Row(mark: high > 0 ? .bad : .warn, text: "\(guessed.count) assumption\(guessed.count == 1 ? "" : "s")" + (high > 0 ? " (\(high) high risk)" : "")))
        }
        if let reqs = r["requirements"]?.arrayValue, !reqs.isEmpty {
            let met = reqs.filter { $0["status"]?.stringValue == "met" }.count
            rows.append(Row(mark: met == reqs.count ? .good : .warn, text: "Requirements met \(met) of \(reqs.count)"))
        }
        return rows
    }

    var riskLabel: String {
        switch risk {
        case "high": "High risk"
        case "medium": "Medium risk"
        default: "Low risk"
        }
    }
}

struct PhoneReceipts: Equatable, Sendable, Decodable {
    var receipts: [PhoneReceipt]
    private enum Key: String, CodingKey { case receipts }

    init(receipts: [PhoneReceipt]) { self.receipts = receipts }

    init(from decoder: Decoder) throws {
        receipts = try decoder.container(keyedBy: Key.self).list(PhoneReceipt.self, .receipts)
    }
}

/// GET /todos: a to-do card.
struct PhoneTodoCard: Identifiable, Equatable, Sendable, Decodable {
    var id: String
    var project: String
    var title: String
    var prompt: String
    var model: String
    var mode: String
    var state: String
    var taskID: Int?
    var untrusted: Bool

    init(id: String, project: String, title: String, prompt: String = "", model: String = "", mode: String = "", state: String = "todo", taskID: Int? = nil, untrusted: Bool = false) {
        self.id = id
        self.project = project
        self.title = title
        self.prompt = prompt
        self.model = model
        self.mode = mode
        self.state = state
        self.taskID = taskID
        self.untrusted = untrusted
    }

    private enum Key: String, CodingKey {
        case id, project, title, prompt, model, mode, state, untrusted
        case taskID = "task_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let id = c.text(.id), !id.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "card without an id"))
        }
        self.id = id
        project = c.text(.project) ?? ""
        title = c.text(.title) ?? ""
        prompt = c.text(.prompt) ?? ""
        model = c.text(.model) ?? ""
        mode = c.text(.mode) ?? ""
        state = c.text(.state) ?? "todo"
        taskID = c.integer(.taskID)
        untrusted = c.flag(.untrusted) ?? false
    }

    var waiting: Bool { state == "todo" || state == "failed" }
    /// Auto and Bypass start on the Mac only.
    var startsOnMacOnly: Bool { mode == "auto" || mode == "smart" }

    var stateLabel: String {
        switch state {
        case "todo": "To do"
        case "queued": "Queued"
        case "running": "Running"
        case "started": "Started"
        case "done": "Done"
        case "failed": "Failed"
        default: state.capitalized
        }
    }
}

struct PhoneTodos: Equatable, Sendable, Decodable {
    var cards: [PhoneTodoCard]
    var queues: JSONValue

    init(cards: [PhoneTodoCard], queues: JSONValue = [:]) {
        self.cards = cards
        self.queues = queues
    }

    private enum Key: String, CodingKey { case cards, queues }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        cards = c.list(PhoneTodoCard.self, .cards)
        queues = c.object(JSONValue.self, .queues) ?? [:]
    }

    var byProject: [(project: String, cards: [PhoneTodoCard])] {
        var order: [String] = []
        var groups: [String: [PhoneTodoCard]] = [:]
        for card in cards {
            if groups[card.project] == nil { order.append(card.project) }
            groups[card.project, default: []].append(card)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }
}

/// GET /usage: the glance.
struct PhoneUsage: Equatable, Sendable, Decodable {
    struct Day: Equatable, Hashable, Sendable, Decodable {
        var day: String
        var total: Double
        private enum Key: String, CodingKey { case day, total }

        init(day: String, total: Double) {
            self.day = day
            self.total = total
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            day = c.text(.day) ?? ""
            total = c.number(.total) ?? 0
        }
    }

    struct Window: Equatable, Hashable, Sendable, Decodable {
        var kind: String
        var percent: Double?
        private enum Key: String, CodingKey { case kind, percent, utilization }

        init(kind: String, percent: Double?) {
            self.kind = kind
            self.percent = percent
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            kind = c.text(.kind) ?? ""
            percent = c.number(.percent) ?? c.number(.utilization).map { $0 <= 1 ? $0 * 100 : $0 }
        }

        var label: String {
            switch kind {
            case "five_hour": "5-hour limit"
            case "seven_day", "weekly": "Weekly limit"
            case "seven_day_opus": "Weekly (Opus)"
            default: kind.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
    }

    var today: Double = 0
    var dayCap: Double = 0
    var recent: [Day] = []
    var windows: [Window] = []

    init(today: Double = 0, dayCap: Double = 0, recent: [Day] = [], windows: [Window] = []) {
        self.today = today
        self.dayCap = dayCap
        self.recent = recent
        self.windows = windows
    }

    private enum Key: String, CodingKey { case today, recent, windows
        case dayCap = "day_cap"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        today = c.number(.today) ?? 0
        dayCap = c.number(.dayCap) ?? 0
        recent = c.list(Day.self, .recent)
        windows = c.list(Window.self, .windows)
    }

    var fiveHour: Window? { windows.first { $0.kind == "five_hour" } ?? windows.first }
    var week: Double { recent.reduce(0) { $0 + $1.total } }
}

/// `{ok, said?, id?, steered?}` answers.
struct PhoneOK: Equatable, Sendable, Decodable {
    var ok: Bool
    var said: String
    var id: Int?
    var steered: Bool

    init(ok: Bool, said: String = "", id: Int? = nil, steered: Bool = false) {
        self.ok = ok
        self.said = said
        self.id = id
        self.steered = steered
    }

    private enum Key: String, CodingKey { case ok, said, id, steered }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        ok = c.flag(.ok) ?? true
        said = c.text(.said) ?? ""
        id = c.integer(.id)
        steered = c.flag(.steered) ?? false
    }
}

enum Money {
    static func text(_ dollars: Double) -> String {
        dollars >= 100 ? String(format: "$%.0f", dollars) : String(format: "$%.2f", dollars)
    }
}
