import Foundation

/// A request sent from this device, followed until the Mac has answered it.
///
/// POST /api/ask usually brings the reply itself. When it comes back early (the request
/// needs a yes, or the Mac's two-minute wait ran out) the reply is picked up from polling
/// /api/state instead: the Mac adds the question to its history when the turn starts and
/// the reply when it ends, and is idle again only after that.
struct PendingRequest: Identifiable, Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        /// POST /api/ask is in flight.
        case sending
        /// /api/ask came back before the reply was done.
        case waiting
        case answered(String)
        case failed(String)
    }

    let id: UUID
    let question: String
    let sentAt: Date
    /// History entries already there when it was sent: an earlier, identical question
    /// isn't this one.
    let known: Set<String>
    var phase: Phase = .sending

    init(question: String, history: [HistoryItem], sentAt: Date = Date()) {
        id = UUID()
        self.question = question
        self.sentAt = sentAt
        known = Set(history.map(\.key))
    }

    var isOpen: Bool { phase == .sending || phase == .waiting }

    var reply: String? {
        if case .answered(let reply) = phase { return reply }
        return nil
    }

    /// Where the Mac's history shows this question, once its turn has started.
    func echo(in history: [HistoryItem]) -> Int? {
        history.indices.first { index in
            let item = history[index]
            return item.role == .user && item.text == question && !known.contains(item.key)
        }
    }

    /// The Mac's reply to it, once the turn has finished.
    func replyInHistory(_ history: [HistoryItem]) -> String? {
        guard let echo = echo(in: history) else { return nil }
        return history[(echo + 1)...].first { $0.role == .assistant }?.text
    }

    /// Catch up with the Mac's state. Returns the reply when this is what finished it.
    mutating func follow(_ state: RemoteState) -> String? {
        if case .failed = phase, echo(in: state.history) != nil {
            phase = .waiting  // the connection dropped (app in the background?), but the Mac got it
        }
        guard phase == .waiting else { return nil }  // while sending, /api/ask brings the reply
        if let reply = replyInHistory(state.history) {
            phase = .answered(reply)
            return reply
        }
        if state.state == .idle, echo(in: state.history) != nil {
            phase = .answered("")  // the turn ended without a reply (stopped)
            return ""
        }
        return nil
    }

    /// The Mac's history now shows the whole exchange, so it needn't be shown separately.
    func isSettled(by history: [HistoryItem]) -> Bool {
        guard case .answered = phase else { return false }
        return replyInHistory(history) != nil
    }

    /// The reply so far, while the Mac is still writing it.
    func streaming(in state: RemoteState) -> String? {
        guard isOpen, state.state != .idle, state.turn.user == question else { return nil }
        return state.turn.reply
    }
}
