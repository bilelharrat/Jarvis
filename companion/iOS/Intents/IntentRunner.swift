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
        /// Asks the Mac to open JARVIS (it was quit); true when it's opening.
        var wake: @Sendable () async -> Bool = { false }
        /// How long to wait between tries while JARVIS opens.
        var pause: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }

        /// Through this device's pinned pairing; nil when it isn't paired.
        static func live() -> Client? {
            guard let pairing = PairingStore.load(), pairing.isPinned else { return nil }
            let api = pairing.api
            return Client(
                ask: { text, timeout in try await api.ask(text, timeout: timeout) },
                command: { command in try await api.command(command) },
                digest: { try await api.digest() },
                keep: { item in try Outbox.shared.add(item) },
                wake: { await api.wake() }
            )
        }
    }

    /// Siri keeps a spoken request open for about this long.
    static let waitForReply: TimeInterval = 25
    /// How long to wait for JARVIS to open on the Mac before keeping the request.
    static let waitForMac: TimeInterval = 15
    /// What a spoken answer is kept to (the whole reply is in the app).
    static let longestSpoken = 900

    static let notPaired = "Open J.A.R.V.I.S. to pair your Mac or add a Claude API key first."

    /// Answers on the iPhone itself (nil when it can't: no API key).
    typealias Local = @Sendable (String) async -> String?

    /// Jarvis on the iPhone, for Siri: answers when there's no Mac or it can't be reached.
    static let phoneAnswer: Local = { text in
        await MainActor.run { BrainSettings.apiKey != nil } ? await PhoneAnswer.ask(text) : nil
    }

    /// Asks Jarvis and returns what to say: the reply, or why there isn't one yet.
    static func ask(_ raw: String, client: Client?, local: Local? = nil, stillWorking: String = "Jarvis is still working on that. The answer will be in the app.") async -> String {
        let text = raw.trimmed
        guard !text.isEmpty else { return "What should I ask Jarvis?" }
        guard let client else {
            if let local, let reply = await local(text) { return spoken(reply) }
            return notPaired
        }
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
            if let reply = await askOnceOpened(text, client: client, stillWorking: stillWorking) { return reply }
            if let local, let reply = await local(text) { return spoken(reply) }
            return keep(.ask(text), client: client)
        } catch {
            return problem(error)
        }
    }

    /// JARVIS on the Mac was quit: open it there and ask again once it answers (nil: it
    /// isn't opening, or didn't come up in time).
    private static func askOnceOpened(_ text: String, client: Client, stillWorking: String) async -> String? {
        guard await client.wake() else { return nil }
        let step: TimeInterval = 2
        var waited: TimeInterval = 0
        while waited < waitForMac {
            await client.pause(step)
            waited += step
            do {
                let result = try await client.ask(text, waitForReply - waited)
                if result.done {
                    let reply = spoken(result.reply)
                    return reply.isEmpty ? "Done." : reply
                }
                return result.approvals.isEmpty ? stillWorking : "Jarvis needs your OK first. It’s waiting on your iPhone."
            } catch let error as JarvisError where error.neverDelivered {
                continue  // not up yet
            } catch JarvisError.timedOut, JarvisError.connectionLost {
                return stillWorking
            } catch {
                return problem(error)
            }
        }
        return nil
    }

    static func brief(client: Client?, local: Local? = nil) async -> String {
        if client == nil, let local, let reply = await local(AppModel.phoneBriefing) { return spoken(reply) }
        return await ask("Brief me.", client: client, local: local, stillWorking: "Your briefing is on its way. It’ll be in J.A.R.V.I.S. in a moment.")
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

/// One question to Jarvis on the iPhone, outside the app's conversation (Siri, Shortcuts).
@MainActor
enum PhoneAnswer {
    private static let brain = LocalBrain()

    static func ask(_ text: String) async -> String? {
        brain.tools.mac = PairingStore.load().flatMap { $0.isPinned ? $0.api : nil }
        return await brain.ask(text, macName: PairingStore.load()?.macLabel)
    }
}
