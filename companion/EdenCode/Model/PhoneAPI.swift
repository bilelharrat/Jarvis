import Foundation

/// Everything Eden Code asks the Mac, as one protocol: the live Mac (JarvisAPI, pinned TLS,
/// straight or through the relay) and the demo (DemoBackend) both answer it,
/// so every screen can be shown, and tested, without a Mac.
protocol CodeBackend: Sendable {
    func home() async throws -> PhoneHome
    func options() async throws -> PhoneOptions
    /// The long poll (docs/eden-code-phone.md): answers at once when there is anything new.
    func session(id: Int, after: Int, seen: Int, v: String, wait: Int) async throws -> PhoneView
    func send(id: Int, text: String) async throws -> PhoneOK
    /// A message with pictures: the companion's /api/code/send, which takes them (the phone
    /// page's /send is text only).
    func send(id: Int, text: String, pictures: [CodeAttachment]) async throws -> PhoneOK
    func steer(id: Int, text: String) async throws -> PhoneOK
    func stop(id: Int) async throws -> PhoneOK
    func answer(card: String, choice: String, feedback: String?) async throws -> PhoneOK
    func setMode(id: Int, mode: String) async throws -> PhoneOK
    func setModel(id: Int, ref: String) async throws -> PhoneOK
    func newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Bool?) async throws -> PhoneOK
    func land(id: Int) async throws -> PhoneOK
    func discard(id: Int) async throws -> PhoneOK
    func unpin() async throws -> PhoneOK
    func changes(id: Int, view: String) async throws -> PhoneChanges
    func hunk(id: Int, hunks: [String], action: String, view: String) async throws -> PhoneHunkResult
    func comment(id: Int, comments: [PhoneComment]) async throws -> PhoneOK
    func receipts(id: Int) async throws -> PhoneReceipts
    func todos() async throws -> PhoneTodos
    func startTodo(card: String) async throws -> PhoneOK
    func usage() async throws -> PhoneUsage
    /// The window's own pull request actions (the companion's /api/code/action: pr_draft, pr_open).
    func openPullRequest(id: Int) async throws -> PhoneOK
}

/// The Mac's /api/code/phone/* calls on the pinned companion connection.
struct LiveBackend: CodeBackend {
    let api: JarvisAPI

    private static let decoder = JSONDecoder()

    private func get<T: Decodable>(_ path: String, _ query: [String: String] = [:], timeout: TimeInterval = 15) async throws -> T {
        let items = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        let data = try await api.request("api/code/phone/\(path)", query: items, timeout: timeout)
        return try Self.decode(T.self, data)
    }

    private func post<T: Decodable>(_ path: String, _ body: JSONValue, timeout: TimeInterval = 20) async throws -> T {
        let data = try await api.request("api/code/phone/\(path)", body: try body.encoded(), timeout: timeout)
        return try Self.decode(T.self, data)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw JarvisError.notJarvis
        }
    }

    func home() async throws -> PhoneHome { try await get("home") }
    func options() async throws -> PhoneOptions { try await get("options", timeout: 20) }

    func session(id: Int, after: Int, seen: Int, v: String, wait: Int) async throws -> PhoneView {
        try await get("session", ["id": String(id), "after": String(after), "seen": String(seen), "v": v, "wait": String(wait)],
                      timeout: TimeInterval(wait) + 15)
    }

    func send(id: Int, text: String) async throws -> PhoneOK { try await post("send", ["id": .int(id), "text": .string(text)]) }
    func send(id: Int, text: String, pictures: [CodeAttachment]) async throws -> PhoneOK {
        PhoneOK(ok: try await api.codeSend(id: id, text: text, attachments: pictures, steer: nil))
    }
    func steer(id: Int, text: String) async throws -> PhoneOK { try await post("steer", ["id": .int(id), "text": .string(text)]) }
    func stop(id: Int) async throws -> PhoneOK { try await post("stop", ["id": .int(id)]) }

    func answer(card: String, choice: String, feedback: String?) async throws -> PhoneOK {
        try await post("answer", .object(dropping: ["approval": .string(card), "choice": .string(choice),
                                                     "feedback": feedback.flatMap { $0.trimmed.isEmpty ? nil : .string($0) }]))
    }

    func setMode(id: Int, mode: String) async throws -> PhoneOK { try await post("mode", ["id": .int(id), "mode": .string(mode)]) }
    func setModel(id: Int, ref: String) async throws -> PhoneOK { try await post("model", ["id": .int(id), "ref": .string(ref)], timeout: 30) }

    func newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Bool?) async throws -> PhoneOK {
        try await post("new", .object(dropping: [
            "directory": .string(directory), "prompt": .string(prompt), "mode": .string(mode),
            "model": model.flatMap { $0.isEmpty ? nil : .string($0) }, "isolated": isolated.map { .bool($0) },
        ]), timeout: 60)
    }

    func land(id: Int) async throws -> PhoneOK { try await post("land", ["id": .int(id)], timeout: 60) }
    func discard(id: Int) async throws -> PhoneOK { try await post("discard", ["id": .int(id)], timeout: 60) }
    func unpin() async throws -> PhoneOK { try await post("unpin", [:]) }
    func changes(id: Int, view: String) async throws -> PhoneChanges { try await get("changes", ["id": String(id), "view": view], timeout: 30) }

    func hunk(id: Int, hunks: [String], action: String, view: String) async throws -> PhoneHunkResult {
        try await post("hunk", ["id": .int(id), "hunks": .array(hunks.map { .string($0) }), "action": .string(action), "view": .string(view)], timeout: 45)
    }

    func comment(id: Int, comments: [PhoneComment]) async throws -> PhoneOK {
        try await post("comments", ["id": .int(id), "comments": .array(comments.map(\.json))])
    }

    func receipts(id: Int) async throws -> PhoneReceipts { try await get("receipts", ["id": String(id), "tail": "5"]) }
    func todos() async throws -> PhoneTodos { try await get("todos") }
    func startTodo(card: String) async throws -> PhoneOK { try await post("todo_start", ["card": .string(card)], timeout: 60) }
    func usage() async throws -> PhoneUsage { try await get("usage") }

    func openPullRequest(id: Int) async throws -> PhoneOK {
        let draft = try await api.codeAction("pr_draft", session: id, timeout: 150)
        let found = draft["code_pr_draft"]
        let title = found?["title"]?.stringValue ?? ""
        let body = found?["body"]?.stringValue ?? ""
        guard !title.isEmpty else {
            return PhoneOK(ok: false, said: draft.said.isEmpty ? "Couldn’t write the pull request’s description." : draft.said)
        }
        let opened = try await api.codeAction("pr_open", session: id, ["title": .string(title), "body": .string(body), "draft": .bool(true)], timeout: 150)
        return PhoneOK(ok: opened.ok, said: opened.said.isEmpty ? "Opened a draft pull request." : opened.said)
    }
}
