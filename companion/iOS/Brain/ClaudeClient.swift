import Foundation

/// Claude's Messages API over plain HTTPS (there's no Swift SDK): one streamed request at a
/// time, its content blocks rebuilt exactly as they arrived so the turn can go back into
/// the conversation unchanged (thinking blocks and their signatures included).
struct ClaudeClient: Sendable {
    /// Whose Claude it is: the owner's own API key straight to Anthropic, or their Jarvis
    /// account through askeden.com (Jarvis Plus, or the trial), which takes the same requests
    /// with the account's token in place of a key.
    enum Credential: Sendable, Equatable {
        case apiKey(String)
        case account(token: String)

        var endpoint: URL {
            switch self {
            case .apiKey: ClaudeClient.endpoint
            case .account: ClaudeClient.accountEndpoint
            }
        }

        var isAccount: Bool {
            if case .account = self { return true }
            return false
        }

        func authorize(_ request: inout URLRequest) {
            switch self {
            case .apiKey(let key): request.setValue(key, forHTTPHeaderField: "x-api-key")
            case .account(let token): request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        }
    }

    let credential: Credential
    var model: String = ClaudeClient.defaultModel
    var effort: String = "low"

    static let defaultModel = "claude-opus-5-5"
    static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    /// askeden.com's Anthropic-compatible proxy, for the AI included with a Jarvis account.
    static let accountEndpoint = URL(string: "https://askeden.com/api/anthropic/v1/messages")!

    init(apiKey: String, model: String = ClaudeClient.defaultModel, effort: String = "low") {
        self.init(credential: .apiKey(apiKey), model: model, effort: effort)
    }

    init(credential: Credential, model: String = ClaudeClient.defaultModel, effort: String = "low") {
        self.credential = credential
        self.model = model
        self.effort = effort
    }

    enum Failure: LocalizedError, Equatable {
        case badKey
        /// The included AI is spent (402 billing_error): the plan's allowance and the trial.
        case noAllowance
        /// askeden.com no longer knows this device's token.
        case signedOut
        case rateLimited
        case overloaded
        case server(Int, String)
        case network(String)
        case malformed

        var errorDescription: String? {
            switch self {
            case .badKey: "Your Claude API key wasn’t accepted. Check it in Settings › Jarvis on iPhone."
            case .noAllowance: "The AI included with your Jarvis account is used up for now. Upgrade to Jarvis Plus for more, or add your own Claude key in Settings › Jarvis on iPhone."
            case .signedOut: "You’ve been signed out of your Jarvis account. Sign in again in Settings › Account."
            case .rateLimited: "Claude is rate limiting this key right now. Try again in a minute."
            case .overloaded: "Claude is busy right now. Try again in a moment."
            case .server(let status, let message): message.isEmpty ? "Claude couldn’t answer (\(status))." : message
            case .network(let message): "Couldn’t reach Claude: \(message)"
            case .malformed: "Claude’s answer couldn’t be read."
            }
        }
    }

    /// One finished response.
    struct Response: Sendable {
        var content: [JSONValue]
        var stopReason: String
        var text: String {
            content.compactMap { block in block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil }.joined()
        }
    }

    /// Sends the conversation and streams the answer; `onText` gets the reply's text so far.
    func send(
        system: String,
        messages: [JSONValue],
        tools: [JSONValue],
        onText: @escaping @Sendable (String) -> Void
    ) async throws -> Response {
        var request = URLRequest(url: credential.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        credential.authorize(&request)
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // A declined request runs again on the model Anthropic recommends for it.
        request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        let body: JSONValue = .object([
            "model": .string(model),
            "max_tokens": .int(16000),
            "stream": .bool(true),
            "system": .array([.object([
                "type": .string("text"), "text": .string(system),
                "cache_control": .object(["type": .string("ephemeral")]),
            ])]),
            "messages": .array(messages.map(\.forClaude)),
            "tools": .array(tools),
            "output_config": .object(["effort": .string(effort)]),
            "fallbacks": .string("default"),
        ])
        request.httpBody = try JSONEncoder().encode(body)

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
            let failure = Self.failure(status: status, body: data, viaAccount: credential.isAccount)
            if failure == .signedOut, case .account(let token) = credential {
                await MainActor.run { AccountStore.shared.tokenRejected(token) }
            }
            throw failure
        }

        var stream = StreamAssembler()
        var event = ""
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let payload = Data(line.dropFirst(5).utf8)
                guard let data = try? JSONDecoder().decode(JSONValue.self, from: payload) else { continue }
                if event == "error" || data["type"]?.stringValue == "error" {
                    let message = data["error"]?["message"]?.stringValue ?? ""
                    throw data["error"]?["type"]?.stringValue == "overloaded_error" ? Failure.overloaded : Failure.server(500, message)
                }
                if stream.take(data) { onText(stream.text) }
            }
        }
        guard let stopReason = stream.stopReason else { throw Failure.malformed }
        return Response(content: stream.blocks, stopReason: stopReason)
    }

    /// viaAccount: the request went through askeden.com on the owner's Jarvis account.
    static func failure(status: Int, body: Data, viaAccount: Bool = false) -> Failure {
        let error = (try? JSONDecoder().decode(JSONValue.self, from: body))?["error"]
        let message = error?["message"]?.stringValue ?? ""
        if status == 402 || error?["type"]?.stringValue == "billing_error" { return .noAllowance }
        switch status {
        case 401 where viaAccount: return .signedOut
        case 401, 403: return .badKey
        case 429: return .rateLimited
        case 529: return .overloaded
        default: return .server(status, message)
        }
    }
}

/// Rebuilds content blocks from the stream's events.
struct StreamAssembler {
    private(set) var blocks: [JSONValue] = []
    private(set) var stopReason: String?
    /// Partial tool input, by block index.
    private var partialJSON: [Int: String] = [:]

    /// The reply's text so far (text blocks only).
    var text: String {
        blocks.compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined()
    }

    /// Takes one event; true when the reply's text changed.
    mutating func take(_ event: JSONValue) -> Bool {
        switch event["type"]?.stringValue {
        case "content_block_start":
            guard let index = event["index"]?.intValue, case .object(var block)? = event["content_block"] else { return false }
            if block["type"]?.stringValue == "tool_use" || block["type"]?.stringValue == "server_tool_use" {
                partialJSON[index] = ""
            }
            if block["type"]?.stringValue == "text", block["text"] == nil { block["text"] = .string("") }
            while blocks.count <= index { blocks.append(.null) }
            blocks[index] = .object(block)
            return false
        case "content_block_delta":
            guard let index = event["index"]?.intValue, index < blocks.count, case .object(var block) = blocks[index],
                  let delta = event["delta"] else { return false }
            var textChanged = false
            switch delta["type"]?.stringValue {
            case "text_delta":
                block["text"] = .string((block["text"]?.stringValue ?? "") + (delta["text"]?.stringValue ?? ""))
                textChanged = true
            case "input_json_delta":
                partialJSON[index, default: ""] += delta["partial_json"]?.stringValue ?? ""
            case "thinking_delta":
                block["thinking"] = .string((block["thinking"]?.stringValue ?? "") + (delta["thinking"]?.stringValue ?? ""))
            case "signature_delta":
                block["signature"] = .string((block["signature"]?.stringValue ?? "") + (delta["signature"]?.stringValue ?? ""))
            case "citations_delta":
                if let citation = delta["citation"] {
                    var citations = block["citations"]?.arrayValue ?? []
                    citations.append(citation)
                    block["citations"] = .array(citations)
                }
            default:
                break
            }
            blocks[index] = .object(block)
            return textChanged
        case "content_block_stop":
            guard let index = event["index"]?.intValue, index < blocks.count, let json = partialJSON.removeValue(forKey: index),
                  case .object(var block) = blocks[index] else { return false }
            // An empty or unreadable input stays empty; the tool refuses it with a reason.
            let parsed = json.isEmpty ? JSONValue.object([:]) : (try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
            block["input"] = parsed ?? .object([:])
            if parsed == nil { block["_invalid_input"] = .bool(true) }
            blocks[index] = .object(block)
            return false
        case "message_delta":
            if let reason = event["delta"]?["stop_reason"]?.stringValue { stopReason = reason }
            return false
        default:
            return false
        }
    }
}

extension JSONValue {
    var intValue: Int? {
        switch self {
        case .int(let value): value
        case .double(let value): Int(value)
        default: nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// The block without the fields this app adds for itself (every key starting with _).
    var forAPI: JSONValue {
        guard case .object(let object) = self else { return self }
        return .object(object.filter { !$0.key.hasPrefix("_") })
    }

    /// A message as Claude takes it: without Gemini's own record of a turn it wrote (the
    /// `_gemini` block), the app's own fields, or empty text.
    var forClaude: JSONValue {
        guard case .object(var message) = self, let blocks = message["content"]?.arrayValue else { return self }
        var kept = blocks.filter { block in
            let type = block["type"]?.stringValue ?? ""
            return !type.hasPrefix("_") && !(type == "text" && (block["text"]?.stringValue ?? "").isEmpty)
        }.map(\.forAPI)
        if kept.isEmpty { kept = [["type": "text", "text": "…"]] }
        message["content"] = .array(kept)
        return .object(message)
    }
}
