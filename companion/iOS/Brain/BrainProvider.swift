import Foundation

/// The model APIs Jarvis on the iPhone answers with, on the owner's own keys.
enum BrainProvider: String, CaseIterable, Identifiable, Sendable {
    case claude
    case gemini

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claude: "Claude"
        case .gemini: "Gemini"
        }
    }

    /// Where its key is kept in the Keychain (Claude's is where it always was).
    var keyAccount: String {
        switch self {
        case .claude: "brain.anthropic-key"
        case .gemini: "brain.gemini-key"
        }
    }

    var modelKey: String {
        switch self {
        case .claude: "brain.model"
        case .gemini: "brain.gemini-model"
        }
    }

    var defaultModel: String {
        switch self {
        case .claude: ClaudeClient.defaultModel
        case .gemini: GeminiClient.defaultModel
        }
    }

    var models: [(id: String, name: String)] {
        switch self {
        case .claude: [
            ("claude-opus-5-5", "Claude Opus 5.5"),
            ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
        ]
        case .gemini: [
            ("gemini-3.8-flash", "Gemini 3.8 Flash"),
            ("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)"),
            ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"),
        ]
        }
    }

    var keyPlaceholder: String {
        switch self {
        case .claude: "Claude API key (sk-ant-…)"
        case .gemini: "Gemini API key (AIza…)"
        }
    }

    /// Where the owner gets a key.
    var console: String {
        switch self {
        case .claude: "console.anthropic.com"
        case .gemini: "aistudio.google.com"
        }
    }

    /// Why a pasted key can't be this service's, or nil when it looks right.
    func problem(with key: String) -> String? {
        switch self {
        case .claude: key.hasPrefix("sk-ant-") ? nil : "That doesn’t look like a Claude API key (they start with sk-ant-)."
        case .gemini: key.count >= 30 && !key.contains(" ") ? nil : "That doesn’t look like a Gemini API key."
        }
    }
}

/// One model API: the conversation in Claude's content blocks, one streamed turn back.
protocol BrainClient: Sendable {
    var provider: BrainProvider { get }
    func send(
        system: String,
        messages: [JSONValue],
        tools: [JSONValue],
        onText: @escaping @Sendable (String) -> Void
    ) async throws -> ClaudeClient.Response
}

extension ClaudeClient: BrainClient {
    var provider: BrainProvider { .claude }
}
