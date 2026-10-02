import Foundation

/// The models Jarvis on the iPhone answers with: Claude and Gemini on the owner's own keys,
/// and Apple's (AppleClient), which need no key, for when there's neither a key nor a Mac.
enum BrainProvider: String, CaseIterable, Identifiable, Sendable {
    case claude
    case gemini
    case apple

    /// The ones that answer on a key of the owner's (Settings' key rows, the order picker).
    static let keyed: [BrainProvider] = [.claude, .gemini]

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claude: "Claude"
        case .gemini: "Gemini"
        case .apple: "Apple Intelligence"
        }
    }

    /// Where its key is kept in the Keychain (Claude's is where it always was).
    var keyAccount: String {
        switch self {
        case .claude: "brain.anthropic-key"
        case .gemini: "brain.gemini-key"
        case .apple: "brain.apple-key"  // never written: Apple's models take no key
        }
    }

    var modelKey: String {
        switch self {
        case .claude: "brain.model"
        case .gemini: "brain.gemini-model"
        case .apple: "brain.apple-model"
        }
    }

    var defaultModel: String {
        switch self {
        case .claude: ClaudeClient.defaultModel
        case .gemini: GeminiClient.defaultModel
        case .apple: "apple"
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
        case .apple: [("apple", "Apple Intelligence")]
        }
    }

    var keyPlaceholder: String {
        switch self {
        case .claude: "Claude API key (sk-ant-…)"
        case .gemini: "Gemini API key (AIza…)"
        case .apple: ""
        }
    }

    /// Where the owner gets a key.
    var console: String {
        switch self {
        case .claude: "console.anthropic.com"
        case .gemini: "aistudio.google.com"
        case .apple: ""
        }
    }

    /// Why a pasted key can't be this service's, or nil when it looks right.
    func problem(with key: String) -> String? {
        switch self {
        case .claude: key.hasPrefix("sk-ant-") ? nil : "That doesn’t look like a Claude API key (they start with sk-ant-)."
        case .gemini: key.count >= 30 && !key.contains(" ") ? nil : "That doesn’t look like a Gemini API key."
        case .apple: "Apple Intelligence takes no key."
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
