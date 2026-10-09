import Foundation

/// An answer to one of the Mac's approval cards, however it was given: a button in the app,
/// a notification action (Allow / Not now / No, because…), or the Watch.
enum ApprovalAnswer: Equatable, Sendable {
    case allow
    case deny
    /// "No, because…": a no that says what to do instead.
    case denyBecause(String)
}

/// What an answer sends to POST /api/approve (the companion contract):
/// - allow: the first choice that isn't a no (usually `allow` or `yes`);
/// - deny: `deny`;
/// - deny because: `deny` with the reason as `feedback` (at most 2,000 characters).
/// A card without a `deny` choice (an Eden Code plan: go / keep planning) gets its own
/// no: the last choice, which is what the Mac picks when nobody answers, and which carries
/// the reason too.
enum ApprovalResponse {
    struct Sent: Equatable, Sendable {
        var choice: String
        var feedback: String?
    }

    static let maxFeedback = 2000

    /// `choices` empty means they aren't known (a notification from an older Mac).
    static func choice(for answer: ApprovalAnswer, choices: [ApprovalChoice]) -> Sent {
        switch answer {
        case .allow:
            let yes = choices.first { !$0.isNegative }
            return Sent(choice: yes?.id ?? "allow", feedback: nil)
        case .deny:
            return Sent(choice: negative(in: choices), feedback: nil)
        case .denyBecause(let reason):
            let reason = String(reason.trimmed.prefix(maxFeedback))
            return Sent(choice: negative(in: choices), feedback: reason.isEmpty ? nil : reason)
        }
    }

    /// The no among the choices.
    static func negative(in choices: [ApprovalChoice]) -> String {
        if choices.isEmpty || choices.contains(where: { $0.id == "deny" }) { return "deny" }
        if let no = choices.last(where: \.isNegative) { return no.id }
        return choices.last?.id ?? "deny"
    }

    /// The notification action behind an answer: Allow, Not now, No because.
    static func answer(forAction identifier: String, text: String?) -> ApprovalAnswer? {
        switch identifier {
        case NotificationCategories.allow: return .allow
        case NotificationCategories.deny: return .deny
        case NotificationCategories.denyReason: return .denyBecause(text ?? "")
        default: return nil
        }
    }
}

/// The notification categories and actions the Mac's pushes use (the companion contract).
enum NotificationCategories {
    static let approval = "JARVIS_APPROVAL"
    static let codeApproval = "JARVIS_CODE_APPROVAL"
    static let headsUp = "JARVIS_HEADSUP"

    static let allow = "ALLOW"
    static let deny = "DENY"
    static let denyReason = "DENY_REASON"

    /// askeden.com's push when one of Eden's background tasks needs the owner's OK (iPhone
    /// only), and its two answers.
    static let edenTaskApproval = "EDEN_TASK_APPROVAL"
    static let edenApprove = "EDEN_APPROVE"
    static let edenDeny = "EDEN_DENY"
}
