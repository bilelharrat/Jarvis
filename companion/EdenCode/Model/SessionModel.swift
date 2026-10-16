import Foundation
import Observation

/// One session on screen: the long poll in a Task while it shows (docs/eden-code-phone.md:
/// after/seen/v, at most 25 s a wait; back off 1, 2, 4 … 30 s on errors), the entries keyed
/// by i with `changed` replacing in place, the streamed words, and what the composer does.
@MainActor
@Observable
final class SessionModel {
    let id: Int
    private(set) var view: PhoneView
    /// Every entry so far, in order (new ones appended, changed ones replaced).
    private(set) var entries: [PhoneEntry] = []
    private(set) var receipts: [PhoneReceipt] = []
    var problem: String?
    var said: String?
    var sending = false
    private(set) var gone = false

    private let backend: any CodeBackend
    private var loop: Task<Void, Never>?

    init(id: Int, backend: any CodeBackend) {
        self.id = id
        self.backend = backend
        view = PhoneView(id: id)
    }

    var working: Bool { view.status == .working }
    var title: String { view.title.isEmpty ? "Session \(id)" : view.title }

    /// Applies one answer of the long poll.
    func apply(_ next: PhoneView) {
        let new = next.entries.filter { entry in !entries.contains { $0.i == entry.i } }
        entries.append(contentsOf: new)
        for entry in next.changed {
            if let index = entries.firstIndex(where: { $0.i == entry.i }) { entries[index] = entry }
        }
        entries.sort { $0.i < $1.i }
        var kept = next
        kept.entries = []
        kept.changed = []
        view = kept
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in await self?.run() }
        Task { await loadReceipts() }
    }

    func stopWatching() {
        loop?.cancel()
        loop = nil
    }

    private func run() async {
        var backoff = 1.0
        var first = true
        while !Task.isCancelled {
            do {
                let next = try await backend.session(id: id, after: view.next, seen: view.seen, v: first ? "" : view.v,
                                                     wait: first ? 0 : 25)
                let finished = view.status == .working && next.status != .working
                apply(next)
                problem = nil
                backoff = 1
                first = false
                if finished { await loadReceipts() }
                if next.more { continue }
            } catch is CancellationError {
                return
            } catch let error as JarvisError {
                if case .gone = error { gone = true; problem = "This session isn’t on your Mac any more."; return }
                problem = error.errorDescription
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(30, backoff * 2)
            } catch {
                if Task.isCancelled { return }
                problem = error.localizedDescription
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(30, backoff * 2)
            }
        }
    }

    func loadReceipts() async {
        if let found = try? await backend.receipts(id: id) { receipts = found.receipts }
    }

    /// The newest receipt (the Changes screen's card).
    var latestReceipt: PhoneReceipt? { receipts.last }

    // MARK: - The composer

    /// Sends: into the running step when steer is true (and it's working), else queued as the
    /// Mac's composer queues it.
    func send(_ text: String, steer: Bool, pictures: [CodeAttachment] = []) async -> Bool {
        let text = text.trimmed
        guard !text.isEmpty || !pictures.isEmpty else { return false }
        sending = true
        defer { sending = false }
        do {
            let ok: PhoneOK
            if !pictures.isEmpty {
                ok = try await backend.send(id: id, text: text, pictures: pictures)
            } else if steer && working {
                ok = try await backend.steer(id: id, text: text)
            } else {
                ok = try await backend.send(id: id, text: text)
            }
            if !ok.ok { problem = "Your Mac didn’t take that. Too many messages may be waiting." }
            return ok.ok
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    func stop() async {
        _ = try? await backend.stop(id: id)
    }

    func setMode(_ mode: String) async {
        do {
            let ok = try await backend.setMode(id: id, mode: mode)
            said = ok.said.isEmpty ? nil : ok.said
            if ok.ok { view.mode = mode; view.modeLabel = CodeModes.name(mode) }
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    func setModel(_ model: PhoneOptions.Model) async {
        do {
            let ok = try await backend.setModel(id: id, ref: model.ref)
            said = ok.said.isEmpty ? nil : ok.said
            if ok.ok { view.model = model.ref; view.modelLabel = model.name }
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    func land() async { await copyAction { try await self.backend.land(id: self.id) } }
    func discard() async { await copyAction { try await self.backend.discard(id: self.id) } }

    private func copyAction(_ run: @escaping () async throws -> PhoneOK) async {
        do {
            said = try await run().said
        } catch {
            problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - What the transcript shows

    /// Rows as the screen draws them: a user bubble, a run of steps, a reply, a note.
    enum Row: Identifiable, Equatable {
        case user(PhoneEntry)
        case steps([PhoneEntry])
        case reply(PhoneEntry)
        case note(PhoneEntry)

        var id: String {
            switch self {
            case .user(let e): "u\(e.i)"
            case .steps(let list): "s\(list.first?.i ?? 0)"
            case .reply(let e): "r\(e.i)"
            case .note(let e): "n\(e.i)"
            }
        }
    }

    nonisolated static func rows(_ entries: [PhoneEntry]) -> [Row] {
        var rows: [Row] = []
        var steps: [PhoneEntry] = []
        func flush() {
            if !steps.isEmpty { rows.append(.steps(steps)); steps = [] }
        }
        for entry in entries {
            switch entry.role {
            case .tool: steps.append(entry)
            case .user: flush(); rows.append(.user(entry))
            case .assistant: flush(); rows.append(.reply(entry))
            case .note: flush(); rows.append(.note(entry))
            }
        }
        flush()
        return rows
    }

    var rows: [Row] { Self.rows(entries) }

    /// What G1 draws: the rows without the step that is running now, which the one live
    /// status line under the transcript says instead ("Running tests · 3 of 41").
    nonisolated static func visibleRows(_ rows: [Row], working: Bool) -> [Row] {
        guard working, case .steps(var steps)? = rows.last, steps.last?.stepRunning == true else { return rows }
        var kept = Array(rows.dropLast())
        steps.removeLast()
        if !steps.isEmpty { kept.append(.steps(steps)) }
        return kept
    }

    /// For VoiceOver: "Working: Running tests", "Finished".
    var statusLine: String {
        switch view.status {
        case .working: view.doing.isEmpty ? "Working" : "Working: \(view.doing)"
        case .needsYou: "Needs you"
        case .done: "Finished"
        case .failed: "Failed"
        default: view.status.label
        }
    }
}
