import Foundation
import FoundationModels

/// Apple's own models, for when there's no Claude or Gemini key and no Mac to answer: Private
/// Cloud Compute (iOS 27: Apple's larger model, on Apple's servers, nothing kept) when it can
/// be reached, and otherwise the model on this iPhone, which needs no network at all. No key,
/// no cost. They run the phone's tools themselves (calendar, reminders, weather, timers…), so
/// a turn comes back finished. They can't look at pictures or read documents, and the one on
/// the iPhone has little room: it gets a short brief, the end of the conversation and the
/// everyday tools.
struct AppleClient: BrainClient {
    /// Runs one of the phone's tools by name, with its input; what it found, as text.
    typealias Runner = @Sendable (String, JSONValue) async -> String

    var provider: BrainProvider { .apple }
    let runner: Runner

    /// The tools the model on the iPhone gets (Private Cloud Compute gets them all).
    static let everyday: Set<String> = [
        "calendar_events", "add_calendar_event", "reminders", "add_reminder", "weather",
        "set_timer", "home", "remember",
    ]
    /// The conversation so far that goes with a question, in characters.
    static let historyRoomy = 6000
    static let historyTight = 1200
    /// The brief the cloud model gets, in characters (the one on the iPhone gets its own).
    static let briefRoomy = 12000

    enum Failure: LocalizedError, Equatable {
        case unavailable
        case refused
        case tooLong

        var errorDescription: String? {
            switch self {
            case .unavailable: "Apple Intelligence isn’t available on this iPhone right now."
            case .refused: "Apple Intelligence wouldn’t answer that one."
            case .tooLong: "That was too long for Apple Intelligence on this iPhone. Try a shorter question, or a new chat."
            }
        }
    }

    /// This iPhone can use one of Apple's models (Apple Intelligence on, the model ready).
    static var isAvailable: Bool {
        if #available(iOS 27, *), PrivateCloudComputeLanguageModel().isAvailable { return true }
        return SystemLanguageModel.default.isAvailable
    }

    func send(
        system: String,
        messages: [JSONValue],
        tools: [JSONValue],
        onText: @escaping @Sendable (String) -> Void
    ) async throws -> ClaudeClient.Response {
        let ask = Self.question(in: messages)
        var lastError: Error = Failure.unavailable
        if #available(iOS 27, *) {
            let cloud = PrivateCloudComputeLanguageModel()
            if cloud.isAvailable {
                let session = LanguageModelSession(
                    model: cloud, tools: Self.tools(tools, runner: runner, everydayOnly: false),
                    instructions: Self.brief(system, roomy: true) + Self.history(messages, limit: Self.historyRoomy)
                )
                do {
                    return try await Self.respond(session, to: ask, onText: onText)
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    lastError = Self.plain(error)  // offline, or over the day's quota: the iPhone's own
                }
            }
        }
        let local = SystemLanguageModel.default
        guard local.isAvailable else { throw lastError }
        // Too long for its context: once more, with no conversation before the question.
        for limit in [Self.historyTight, 0] {
            let session = LanguageModelSession(
                model: local, tools: Self.tools(tools, runner: runner, everydayOnly: true),
                instructions: Self.brief(system, roomy: false) + Self.history(messages, limit: limit)
            )
            do {
                return try await Self.respond(session, to: ask, onText: onText)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = Self.plain(error)
                guard lastError as? Failure == .tooLong else { break }
            }
        }
        throw lastError
    }

    private static func respond(
        _ session: LanguageModelSession, to question: String, onText: @escaping @Sendable (String) -> Void
    ) async throws -> ClaudeClient.Response {
        var text = ""
        for try await snapshot in session.streamResponse(to: question) {
            text = snapshot.content
            onText(text)
        }
        return ClaudeClient.Response(content: [["type": "text", "text": .string(text)]], stopReason: "end_turn")
    }

    /// A failure in the owner's words.
    static func plain(_ error: Error) -> Error {
        if #available(iOS 27, *), let error = error as? LanguageModelError {
            switch error {
            case .contextSizeExceeded: return Failure.tooLong
            case .guardrailViolation, .refusal: return Failure.refused
            default: return error
            }
        }
        if let error = error as? LanguageModelSession.GenerationError {
            switch error {
            case .exceededContextWindowSize: return Failure.tooLong
            case .guardrailViolation, .refusal: return Failure.refused
            case .assetsUnavailable: return Failure.unavailable
            default: return error
            }
        }
        return error
    }

    // MARK: - What the model is given

    /// The question: the text of the last thing the owner said, and a word about what it
    /// carried that this model can't see.
    static func question(in messages: [JSONValue]) -> String {
        guard let last = messages.last else { return "" }
        let blocks = last["content"]?.arrayValue ?? []
        let text = blocks.compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined(separator: "\n")
        let unseen = blocks.filter { ["image", "document"].contains($0["type"]?.stringValue ?? "") }.count
        let question = last["content"]?.stringValue ?? text
        guard unseen > 0 else { return question }
        return question + "\n\n(The owner also sent \(unseen == 1 ? "a picture or file" : "\(unseen) pictures or files") with this, which you can’t see. If the answer depends on it, say so.)"
    }

    /// What was said before the question, newest kept, at most limit characters.
    static func history(_ messages: [JSONValue], limit: Int) -> String {
        guard limit > 0 else { return "" }
        var lines: [String] = []
        var used = 0
        for message in messages.dropLast().reversed() {
            let role = message["role"]?.stringValue == "assistant" ? "Jarvis" : "Owner"
            let content = message["content"]
            let text = content?.stringValue
                ?? (content?.arrayValue ?? []).compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined(separator: " ")
            let line = text.trimmed
            guard !line.isEmpty else { continue }  // a turn of tool results
            let entry = "\(role): \(line)"
            guard used + entry.count <= limit else { break }
            lines.append(entry)
            used += entry.count
        }
        guard !lines.isEmpty else { return "" }
        return "\n\nThe conversation so far:\n" + lines.reversed().joined(separator: "\n")
    }

    /// The brief: Jarvis's own for the cloud model (cut to fit), a short one on the iPhone,
    /// with today's date and the owner's name if Jarvis knows it.
    static func brief(_ system: String, roomy: Bool) -> String {
        if roomy { return String(system.prefix(briefRoomy)) }
        let now = Date().formatted(.dateTime.weekday(.wide).day().month(.wide).year().hour().minute())
        var brief = """
        You are Jarvis, the owner's personal assistant, answering on their iPhone. It's \(now). \
        Answer in a sentence or two, plainly, the way you'd say it out loud. Use the tools for \
        their calendar, reminders, weather, timers and home; never guess what a tool would say. \
        If something needs their Mac (files, mail, messages, code), say the Mac isn't reachable right now.
        """
        let address = UserDefaults.standard.string(forKey: "brain.address")?.trimmed ?? ""
        if !address.isEmpty { brief += " Call the owner \(address)." }
        return brief
    }

    /// The phone's tools as Apple's models take them. everydayOnly: just `everyday`. A server
    /// tool (Anthropic's web search) and one asked of a Mac that isn't there are left out.
    static func tools(_ definitions: [JSONValue], runner: @escaping Runner, everydayOnly: Bool) -> [any Tool] {
        definitions.compactMap { definition in
            guard definition["type"] == nil, let name = definition["name"]?.stringValue,
                  !everydayOnly || everyday.contains(name),
                  let parameters = schema(for: definition) else { return nil }
            return PhoneTool(name: name, description: definition["description"]?.stringValue ?? name,
                             parameters: parameters, runner: runner)
        }
    }

    /// A tool's input schema (Claude's JSON Schema: an object of strings, numbers and
    /// booleans) as a schema Apple's models generate to. nil when it has another shape.
    static func schema(for definition: JSONValue) -> GenerationSchema? {
        guard let name = definition["name"]?.stringValue,
              case .object(let properties)? = definition["input_schema"]?["properties"] else { return nil }
        let required = Set((definition["input_schema"]?["required"]?.arrayValue ?? []).compactMap(\.stringValue))
        var fields: [DynamicGenerationSchema.Property] = []
        for (key, property) in properties.sorted(by: { $0.key < $1.key }) {
            let type: DynamicGenerationSchema
            switch property["type"]?.stringValue {
            case "string": type = DynamicGenerationSchema(type: String.self)
            case "integer": type = DynamicGenerationSchema(type: Int.self)
            case "number": type = DynamicGenerationSchema(type: Double.self)
            case "boolean": type = DynamicGenerationSchema(type: Bool.self)
            default: return nil
            }
            fields.append(.init(name: key, description: property["description"]?.stringValue, schema: type,
                                isOptional: !required.contains(key)))
        }
        return try? GenerationSchema(root: DynamicGenerationSchema(name: name, properties: fields), dependencies: [])
    }

    /// The JSON input Claude's tools take, from what Apple's model generated.
    static func input(from content: GeneratedContent) -> JSONValue {
        (try? JSONDecoder().decode(JSONValue.self, from: Data(content.jsonString.utf8))) ?? [:]
    }
}

/// One of the phone's tools, for Apple's models: its schema built at run time, and run as
/// Claude's are.
private struct PhoneTool: Tool {
    let name: String
    let description: String
    let parameters: GenerationSchema
    let runner: AppleClient.Runner

    func call(arguments: GeneratedContent) async throws -> String {
        await runner(name, AppleClient.input(from: arguments))
    }
}
