import Foundation

/// Google's Gemini API (generateContent, streamed) speaking the conversation Jarvis on the
/// iPhone keeps in Claude's content blocks, so one conversation can move between the two.
///
/// Going out, Claude's blocks become Gemini parts: text, images, tool calls (functionCall)
/// and their results (functionResponse); the web tools become Google Search and URL context.
/// Coming back, Gemini's parts become blocks the brain already runs (text, tool_use), and the
/// parts themselves are kept exactly as they came in a hidden `_gemini` block, so the next
/// request replays them untouched (thought signatures and server-side tool calls included).
/// Claude never sees that block (`forClaude`).
struct GeminiClient: BrainClient {
    let apiKey: String
    var model: String = GeminiClient.defaultModel
    var thinkingLevel = "LOW"

    var provider: BrainProvider { .gemini }

    static let defaultModel = "gemini-3.8-flash"
    /// What Gemini takes in place of a signature for a tool call it didn't make (one Claude
    /// made earlier in the conversation): the value Google's own Gemini CLI sends.
    static let unsignedCall = "skip_thought_signature_validator"

    /// Whether this model takes Google Search and URL context beside the app's own tools
    /// (a preview feature); false after the API said no once.
    nonisolated(unsafe) static var combinesTools = true

    enum Failure: LocalizedError, Equatable {
        case badKey
        case rateLimited
        case overloaded
        case server(Int, String)
        case network(String)
        case malformed

        var errorDescription: String? {
            switch self {
            case .badKey: "Your Gemini API key wasn’t accepted. Check it in Settings › Jarvis on iPhone."
            case .rateLimited: "Gemini is rate limiting this key right now. Try again in a minute."
            case .overloaded: "Gemini is busy right now. Try again in a moment."
            case .server(let status, let message): message.isEmpty ? "Gemini couldn’t answer (\(status))." : message
            case .network(let message): "Couldn’t reach Gemini: \(message)"
            case .malformed: "Gemini’s answer couldn’t be read."
            }
        }
    }

    func send(
        system: String,
        messages: [JSONValue],
        tools: [JSONValue],
        onText: @escaping @Sendable (String) -> Void
    ) async throws -> ClaudeClient.Response {
        do {
            return try await request(system: system, messages: messages, tools: tools, builtIns: Self.combinesTools, onText: onText)
        } catch Failure.server(400, let message) where Self.combinesTools && message.localizedCaseInsensitiveContains("tool") {
            Self.combinesTools = false  // this model won't mix Search with the app's tools: without them
            return try await request(system: system, messages: messages, tools: tools, builtIns: false, onText: onText)
        }
    }

    private func request(
        system: String, messages: [JSONValue], tools: [JSONValue], builtIns: Bool,
        onText: @escaping @Sendable (String) -> Void
    ) async throws -> ClaudeClient.Response {
        let path = "https://generativelanguage.googleapis.com/v1beta/models/\(model):streamGenerateContent?alt=sse"
        guard let url = URL(string: path) else { throw Failure.malformed }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(Self.body(system: system, messages: messages, tools: tools, builtIns: builtIns, thinkingLevel: thinkingLevel))

        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await URLSession.shared.bytes(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Failure.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            throw Self.failure(status: status, body: data)
        }

        var stream = GeminiStream()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data:") else { continue }
            guard let chunk = try? JSONDecoder().decode(JSONValue.self, from: Data(line.dropFirst(5).utf8)) else { continue }
            if let message = chunk["error"]?["message"]?.stringValue { throw Failure.server(500, message) }
            if stream.take(chunk) { onText(stream.text) }
        }
        guard let finished = stream.response else { throw Failure.malformed }
        return finished
    }

    static func failure(status: Int, body: Data) -> Failure {
        let error = (try? JSONDecoder().decode(JSONValue.self, from: body))?["error"]
        let message = error?["message"]?.stringValue ?? ""
        let reason = error?["status"]?.stringValue ?? ""
        switch status {
        case 401, 403: return .badKey
        case 400 where message.localizedCaseInsensitiveContains("API key") || reason == "UNAUTHENTICATED": return .badKey
        case 429: return .rateLimited
        case 500, 502, 503, 504: return .overloaded
        default: return .server(status, message)
        }
    }

    // MARK: - Claude's blocks to Gemini's request

    static func body(system: String, messages: [JSONValue], tools: [JSONValue], builtIns: Bool, thinkingLevel: String) -> JSONValue {
        var body: [String: JSONValue] = [
            "systemInstruction": ["parts": [["text": .string(system)]]],
            "contents": .array(contents(messages)),
            "generationConfig": [
                "maxOutputTokens": 8192,
                "thinkingConfig": ["thinkingLevel": .string(thinkingLevel)],
            ],
        ]
        let declared = Self.tools(tools, builtIns: builtIns)
        if !declared.isEmpty { body["tools"] = .array(declared) }
        if builtIns, declared.count > 1 { body["toolConfig"] = ["includeServerSideToolInvocations": true] }
        return .object(body)
    }

    /// The app's tools as function declarations; the web tools as Google's own.
    static func tools(_ tools: [JSONValue], builtIns: Bool) -> [JSONValue] {
        var functions: [JSONValue] = []
        var google: [JSONValue] = []
        for tool in tools {
            if let type = tool["type"]?.stringValue {
                guard builtIns else { continue }
                if type.hasPrefix("web_search") { google.append(["googleSearch": [:]]) }
                if type.hasPrefix("web_fetch") { google.append(["urlContext": [:]]) }
                continue
            }
            guard let name = tool["name"]?.stringValue else { continue }
            var function: [String: JSONValue] = ["name": .string(name), "description": tool["description"] ?? ""]
            if let schema = tool["input_schema"], case .object(let properties)? = schema["properties"], !properties.isEmpty {
                function["parametersJsonSchema"] = schema
            }
            functions.append(.object(function))
        }
        return (functions.isEmpty ? [] : [["functionDeclarations": .array(functions)]]) + google
    }

    /// The conversation as Gemini's contents. A turn Gemini wrote goes back as it came.
    static func contents(_ messages: [JSONValue]) -> [JSONValue] {
        var names: [String: String] = [:]  // tool_use id → tool name, for the results
        var fromGemini: Set<String> = []  // tool_use ids Gemini gave itself
        var contents: [JSONValue] = []
        for message in messages {
            let blocks = message["content"]?.arrayValue ?? []
            let role = message["role"]?.stringValue == "assistant" ? "model" : "user"
            for block in blocks where block["type"]?.stringValue == "tool_use" {
                if let id = block["id"]?.stringValue, let name = block["name"]?.stringValue {
                    names[id] = name
                    if block["_gemini_id"]?.boolValue == true { fromGemini.insert(id) }
                }
            }
            if role == "model", let raw = blocks.first(where: { $0["type"]?.stringValue == "_gemini" })?["parts"]?.arrayValue {
                contents.append(["role": "model", "parts": .array(raw)])
                continue
            }
            var parts: [JSONValue] = []
            var signed = false
            for block in blocks {
                switch block["type"]?.stringValue {
                case "text":
                    if let text = block["text"]?.stringValue, !text.isEmpty { parts.append(["text": .string(text)]) }
                case "image":
                    if let data = block["source"]?["data"]?.stringValue {
                        parts.append(["inlineData": ["mimeType": block["source"]?["media_type"] ?? "image/jpeg", "data": .string(data)]])
                    }
                case "tool_use":
                    var part: [String: JSONValue] = ["functionCall": ["name": block["name"] ?? "", "args": block["input"] ?? [:]]]
                    if !signed {  // Claude's call: Gemini needs a signature on the first call of a turn
                        part["thoughtSignature"] = .string(unsignedCall)
                        signed = true
                    }
                    parts.append(.object(part))
                case "tool_result":
                    let id = block["tool_use_id"]?.stringValue ?? ""
                    let output = resultText(block["content"])
                    var response: [String: JSONValue] = [
                        "name": .string(names[id] ?? "tool"),
                        "response": block["is_error"]?.boolValue == true ? ["error": .string(output)] : ["result": .string(output)],
                    ]
                    if fromGemini.contains(id) { response["id"] = .string(id) }
                    parts.append(["functionResponse": .object(response)])
                default:
                    break  // thinking, Anthropic's own web search blocks: Claude's alone
                }
            }
            guard !parts.isEmpty else { continue }
            contents.append(["role": .string(role), "parts": .array(parts)])
        }
        return contents
    }

    private static func resultText(_ content: JSONValue?) -> String {
        if let text = content?.stringValue { return text }
        return (content?.arrayValue ?? []).compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
    }
}

/// Puts the streamed chunks back together: the parts as Gemini will want them again, and the
/// blocks the brain runs.
struct GeminiStream {
    private(set) var parts: [JSONValue] = []
    private var finishReason: String?
    private var blocked = false

    /// The reply's text so far.
    var text: String {
        parts.filter { $0["thought"]?.boolValue != true }.compactMap { $0["text"]?.stringValue }.joined()
    }

    /// Takes one chunk; true when the reply's text changed.
    mutating func take(_ chunk: JSONValue) -> Bool {
        if chunk["promptFeedback"]?["blockReason"]?.stringValue != nil { blocked = true }
        guard let candidate = chunk["candidates"]?.arrayValue?.first else { return false }
        if let reason = candidate["finishReason"]?.stringValue { finishReason = reason }
        var changed = false
        for part in candidate["content"]?["parts"]?.arrayValue ?? [] {
            guard case .object(let incoming) = part else { continue }
            let isText = incoming["text"] != nil && incoming["thought"]?.boolValue != true
            if isText, case .object(var last)? = parts.last, last["text"] != nil, last["thought"]?.boolValue != true {
                // One reply arrives in pieces: it goes back as one part, signature kept.
                last["text"] = .string((last["text"]?.stringValue ?? "") + (incoming["text"]?.stringValue ?? ""))
                if let signature = incoming["thoughtSignature"] { last["thoughtSignature"] = signature }
                parts[parts.count - 1] = .object(last)
            } else {
                parts.append(part)
            }
            if isText, !(incoming["text"]?.stringValue ?? "").isEmpty { changed = true }
        }
        return changed
    }

    /// The finished turn, in Claude's terms.
    var response: ClaudeClient.Response? {
        if blocked { return ClaudeClient.Response(content: [], stopReason: "refusal") }
        guard finishReason != nil || !parts.isEmpty else { return nil }
        var blocks: [JSONValue] = []
        for (index, part) in parts.enumerated() {
            if let call = part["functionCall"] {
                let given = call["id"]?.stringValue
                var block: [String: JSONValue] = [
                    "type": "tool_use",
                    "id": .string(given ?? "gemini_\(index)_\(UUID().uuidString.prefix(8))"),
                    "name": call["name"] ?? "",
                    "input": call["args"] ?? [:],
                ]
                if given != nil { block["_gemini_id"] = true }
                blocks.append(.object(block))
            } else if part["thought"]?.boolValue != true, let text = part["text"]?.stringValue, !text.isEmpty {
                blocks.append(["type": "text", "text": .string(text)])
            }
        }
        blocks.append(["type": "_gemini", "parts": .array(parts)])
        let calls = blocks.contains { $0["type"]?.stringValue == "tool_use" }
        let stop: String
        switch finishReason {
        case "MAX_TOKENS": stop = "max_tokens"
        case "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION": stop = "refusal"
        default: stop = calls ? "tool_use" : "end_turn"
        }
        return ClaudeClient.Response(content: blocks, stopReason: stop)
    }
}
