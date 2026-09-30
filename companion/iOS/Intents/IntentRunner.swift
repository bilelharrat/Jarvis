import Foundation

/// What Siri, Shortcuts, Spotlight and the Action Button get from Jarvis: always a short
/// sentence to say or show, never an error dialog. Siri waits only so long, so a request
/// that takes longer carries on on the Mac and its answer lands in the app.
enum IntentRunner {
    /// How the intents reach the Mac (a fake one in tests).
    struct Client: Sendable {
        var ask: @Sendable (_ text: String, _ timeout: TimeInterval) async throws -> AskResult
        var command: @Sendable (MacCommand) async throws -> Void
        var digest: @Sendable () async throws -> Digest
        /// Keeps a request for when the Mac is back.
        var keep: @Sendable (OutboxItem) throws -> Void

        /// Through this device's pinned pairing; nil when it isn't paired.
        static func live() -> Client? {
            guard let pairing = PairingStore.load(), pairing.isPinned else { return nil }
            let api = pairing.api
            return Client(
                ask: { text, timeout in try await api.ask(text, timeout: timeout) },
                command: { command in try await api.command(command) },
                digest: { try await api.digest() },
                keep: { item in try Outbox.shared.add(item) }
            )
        }
    }

    /// Siri keeps a spoken request open for about this long.
    static let waitForReply: TimeInterval = 25
    /// What a spoken answer is kept to (the whole reply is in the app).
    static let longestSpoken = 900

    static let notPaired = "Open J.A.R.V.I.S. and pair it with your Mac first."

    /// Asks Jarvis and returns what to say: the reply, or why there isn't one yet.
    static func ask(_ raw: String, client: Client?, stillWorking: String = "Jarvis is still working on that. The answer will be in the app.") async -> String {
        let text = raw.trimmed
        guard !text.isEmpty else { return "What should I ask Jarvis?" }
        guard let client else { return notPaired }
        do {
            let result = try await client.ask(text, waitForReply)
            if result.done {
                let reply = spoken(result.reply)
                return reply.isEmpty ? "Done." : reply
            }
            if !result.approvals.isEmpty {
                return "Jarvis needs your OK first. It’s waiting on your iPhone."
            }
            return stillWorking
        } catch JarvisError.timedOut, JarvisError.connectionLost {
            return stillWorking  // the Mac has it and carries on
        } catch let error as JarvisError where error.neverDelivered {
            return keep(.ask(text), client: client)
        } catch {
            return problem(error)
        }
    }

    static func brief(client: Client?) async -> String {
        await ask("Brief me.", client: client, stillWorking: "Your briefing is on its way. It’ll be in J.A.R.V.I.S. in a moment.")
    }

    static func whatDidIMiss(client: Client?) async -> String {
        guard let client else { return notPaired }
        do {
            return try await client.digest().spoken
        } catch let error as JarvisError where error.neverDelivered {
            return "Your Mac isn’t reachable right now, so I can’t check."
        } catch {
            return problem(error)
        }
    }

    /// Stop, and meeting notes: about this moment, so never kept for later.
    static func run(_ command: MacCommand, client: Client?) async -> String {
        guard let client else { return notPaired }
        do {
            try await client.command(command)
            switch command {
            case .stop: return "Stopped."
            case .meetingStart: return "Taking meeting notes on your Mac."
            case .meetingStop: return "Stopped. Jarvis is writing up the notes."
            case .briefing: return "Your briefing is on its way."
            case .runRoutine: return "Started on your Mac."
            }
        } catch let error as JarvisError where error.neverDelivered {
            return "Your Mac isn’t reachable right now."
        } catch {
            return problem(error)
        }
    }

    private static func keep(_ item: OutboxItem, client: Client) -> String {
        do {
            try client.keep(item)
            return "Your Mac isn’t reachable. I’ll send it when it’s back, within the hour."
        } catch {
            return "Your Mac isn’t reachable right now."
        }
    }

    private static func problem(_ error: Error) -> String {
        switch error as? JarvisError {
        case .unpaired?: return "Your Mac doesn’t know this iPhone anymore. Open J.A.R.V.I.S. to pair again."
        case .busy?: return "Jarvis is still on your last request. Try again in a moment."
        case .certificateMismatch?: return "That isn’t your Mac. Open J.A.R.V.I.S. to check."
        case let known?: return "Jarvis couldn’t do that. \(known.title)."
        case nil: return "Jarvis couldn’t do that right now."
        }
    }

    /// Markdown and links out, and short enough to hear.
    static func spoken(_ reply: String) -> String {
        let clean = Speakable.clean(reply)
        guard clean.count > longestSpoken else { return clean }
        let head = String(clean.prefix(longestSpoken))
        if let end = head.lastIndex(where: { ".!?".contains($0) }), head.distance(from: head.startIndex, to: end) > 200 {
            return String(head[...end]) + " The rest is in the app."
        }
        return head + "… The rest is in the app."
    }
}
