import Foundation

/// One line of the conversation on screen.
struct TranscriptLine: Identifiable, Equatable {
    enum Kind: Equatable {
        case user, jarvis, problem
    }

    let id: String
    var kind: Kind
    var text: String
    var time: Date?
    /// Jarvis is still working on it (the text grows as it streams).
    var live = false
    /// Sent from here, not yet seen on the Mac.
    var sending = false
    /// On hold until someone answers an approval.
    var onHold = false
    /// Kept on this iPhone until the Mac can be reached.
    var waiting = false
    /// Answered by Jarvis on the iPhone.
    var onPhone = false
    /// What Jarvis is doing right now ("Checking your calendar").
    var activity: String?
    /// Small copies of the pictures sent with a question (JPEG).
    var pictures: [Data] = []
    /// The names of documents sent with a question.
    var files: [String] = []
    /// A problem upgrading the Jarvis account fixes (the included AI ran out).
    var offersUpgrade = false
}

/// What can be done with a line of the conversation (a long press on it).
enum LineAction: Equatable {
    case readAloud, regenerate, edit, good, bad
    /// Opens the Jarvis account, to upgrade to Jarvis Plus.
    case upgrade
}

/// Builds the conversation from the Mac's history, the turn it's working on right now, the
/// request this phone has in flight, and the questions waiting for the Mac, without showing
/// anything twice.
enum Transcript {
    /// pictures: what this phone sent with a question, by the question (the Mac's history
    /// keeps only the words).
    static func lines(state: RemoteState?, pending: PendingRequest?, queued: [OutboxItem] = [], pictures: [String: [Data]] = [:]) -> [TranscriptLine] {
        var lines = conversation(state: state, pending: pending)
        if !pictures.isEmpty {
            for index in lines.indices where lines[index].kind == .user {
                lines[index].pictures = pictures[lines[index].text] ?? []
            }
        }
        for item in queued where item.kind == .ask {
            lines.append(TranscriptLine(id: "q:\(item.id)", kind: .user, text: item.question ?? item.label, time: item.createdAt, waiting: true))
        }
        return lines
    }

    private static func conversation(state: RemoteState?, pending: PendingRequest?) -> [TranscriptLine] {
        let history = state?.history ?? []
        var lines: [TranscriptLine] = []
        var seen: [String: Int] = [:]
        for item in history where item.role != .other && !item.text.trimmed.isEmpty {
            let repeatCount = seen[item.key, default: 0]
            seen[item.key] = repeatCount + 1
            lines.append(TranscriptLine(
                id: "h:\(item.key)#\(repeatCount)",
                kind: item.role == .user ? .user : .jarvis,
                text: item.text,
                time: item.date
            ))
        }

        // A turn the Mac is on right now that isn't ours: asked on the Mac, a routine, the briefing.
        if let state, let live = liveTurn(in: state), live.question != pending?.question {
            lines.append(TranscriptLine(id: "live:\(live.question)", kind: .jarvis, text: live.reply, live: true))
        }

        guard let pending else { return lines }
        if pending.echo(in: history) == nil {
            lines.append(TranscriptLine(
                id: "p:\(pending.id):q", kind: .user, text: pending.question,
                time: pending.sentAt, sending: pending.phase == .sending
            ))
        }
        guard pending.replyInHistory(history) == nil else { return lines }
        let id = "p:\(pending.id):a"
        switch pending.phase {
        case .answered(let reply):
            lines.append(TranscriptLine(id: id, kind: .jarvis, text: reply.isEmpty ? "Done." : reply, time: nil))
        case .failed(let message):
            lines.append(TranscriptLine(id: id, kind: .problem, text: message))
        case .sending, .waiting:
            let streaming = state.flatMap { pending.streaming(in: $0) } ?? ""
            let onHold = streaming.isEmpty && !(state?.approvals.isEmpty ?? true)
            lines.append(TranscriptLine(id: id, kind: .jarvis, text: streaming, live: true, onHold: onHold))
        }
        return lines
    }

    /// The turn in progress on the Mac: its question is the newest in history and has no
    /// reply there yet.
    static func liveTurn(in state: RemoteState) -> (question: String, reply: String)? {
        guard state.state == .thinking || state.state == .speaking, !state.turn.user.isEmpty,
              let last = state.history.lastIndex(where: { $0.role == .user }),
              state.history[last].text == state.turn.user,
              !state.history[(last + 1)...].contains(where: { $0.role == .assistant })
        else { return nil }
        return (state.turn.user, state.turn.reply)
    }
}
