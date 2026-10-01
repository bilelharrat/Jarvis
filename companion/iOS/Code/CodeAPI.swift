import Foundation

/// Jarvis Code from the iPhone, the whole of it (the Mac's companion_code.py): what a new
/// session can be, starting one, and every session action the Mac's window has.
struct CodeOptions: Equatable, Sendable {
    struct Project: Identifiable, Equatable, Sendable {
        var name: String
        var branch: String
        var running: Int
        var id: String { name }
    }

    struct Choice: Identifiable, Equatable, Sendable {
        var id: String
        var name: String
    }

    var projects: [Project] = []
    var models: [Choice] = []
    var modes: [Choice] = []
    var efforts: [String] = []
    var defaultModel = ""
    var defaultMode = "ask"
    var defaultEffort = ""

    init() {}

    init(_ json: JSONValue) {
        projects = (json["projects"]?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue, !name.isEmpty else { return nil }
            return Project(name: name, branch: item["branch"]?.stringValue ?? "", running: item["running"]?.intValue ?? 0)
        }
        models = (json["models"]?.arrayValue ?? []).compactMap { item in
            item["ref"]?.stringValue.map { Choice(id: $0, name: item["name"]?.stringValue ?? $0) }
        }
        modes = (json["modes"]?.arrayValue ?? []).compactMap { item in
            item["id"]?.stringValue.map { Choice(id: $0, name: item["name"]?.stringValue ?? $0) }
        }
        efforts = (json["efforts"]?.arrayValue ?? []).compactMap(\.stringValue)
        defaultModel = json["defaults"]?["model"]?.stringValue ?? ""
        defaultMode = json["defaults"]?["mode"]?.stringValue ?? "ask"
        defaultEffort = json["defaults"]?["effort"]?.stringValue ?? ""
    }

    /// Permission modes, as the Mac names them.
    static func modeName(_ id: String) -> String {
        switch id {
        case "plan": "Plan"
        case "ask": "Manual"
        case "edits": "Accept edits"
        case "smart": "Auto"
        case "auto": "Bypass permissions"
        default: id
        }
    }

    /// Ones that let it run things without asking: Face ID first.
    static func needsOwner(mode: String) -> Bool { mode == "auto" }
}

/// What an action answered: whether it went, what the Mac said, and the events it waited for.
struct CodeActionResult: Sendable {
    var ok: Bool
    var said: String
    var body: JSONValue

    init(_ json: JSONValue) {
        ok = json["ok"]?.boolValue ?? true
        said = json["said"]?.stringValue ?? ""
        body = json
    }

    subscript(event: String) -> JSONValue? { body[event] }
}

/// A picture or PDF sent with a message, as the Mac's composer takes them.
struct CodeAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    var name: String
    var mediaType: String
    var data: Data
    var thumbnail: Data?

    var json: JSONValue {
        ["media_type": .string(mediaType), "data": .string(data.base64EncodedString()), "name": .string(name)]
    }
}

extension JarvisAPI {
    func codeOptions() async throws -> CodeOptions {
        let data = try await request("api/code/options", timeout: 20)
        return CodeOptions((try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:])
    }

    /// Starts a session; its id.
    func codeNew(prompt: String, project: String, model: String?, mode: String?, effort: String?,
                 isolated: Bool?, attachments: [CodeAttachment]) async throws -> Int {
        var fields: [String: JSONValue] = ["prompt": .string(prompt), "directory": .string(project)]
        if let model, !model.isEmpty { fields["model"] = .string(model) }
        if let mode, !mode.isEmpty { fields["mode"] = .string(mode) }
        if let effort, !effort.isEmpty { fields["effort"] = .string(effort) }
        if let isolated { fields["isolated"] = .bool(isolated) }
        if !attachments.isEmpty { fields["images"] = .array(attachments.map(\.json)) }
        let data = try await request("api/code/new", body: try JSONValue.object(fields).encoded(), timeout: 60)
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:]
        guard let id = json["id"]?.intValue else { throw JarvisError.rejected(json["error"]?.stringValue ?? "The session didn’t start.") }
        return id
    }

    /// One of the Mac's session actions (companion_code.ACTIONS).
    @discardableResult
    func codeAction(_ action: String, session: Int?, _ fields: [String: JSONValue] = [:], timeout: TimeInterval = 45) async throws -> CodeActionResult {
        var body = fields
        body["action"] = .string(action)
        if let session { body["id"] = .int(session) }
        let data = try await request("api/code/action", body: try JSONValue.object(body).encoded(), timeout: timeout)
        return CodeActionResult((try? JSONDecoder().decode(JSONValue.self, from: data)) ?? [:])
    }

    /// A message with pictures, or one that goes into the running step now (steer).
    func codeSend(id: Int, text: String, attachments: [CodeAttachment], steer: Bool?) async throws -> Bool {
        var fields: [String: JSONValue] = ["id": .int(id), "text": .string(text)]
        if !attachments.isEmpty { fields["images"] = .array(attachments.map(\.json)) }
        if let steer { fields["steer"] = .bool(steer) }
        let data = try await request("api/code/send", body: try JSONValue.object(fields).encoded(),
                                     timeout: attachments.isEmpty ? 15 : 120,
                                     headers: attachments.isEmpty ? [:] : ["x-jarvis-pictures": "1"])
        return (try? JSONDecoder().decode(JSONValue.self, from: data))?["ok"]?.boolValue ?? true
    }
}
