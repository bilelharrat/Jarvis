import AppIntents
import Foundation

// Siri, Shortcuts, Spotlight and the Action Button. Each runs in the background (the app
// doesn't open), reaches the Mac over the pinned pairing, and answers with a short dialog,
// which Siri speaks when it was asked by voice. The Mac runs requests from the phone as
// silent turns, so nothing is said in an empty room.

struct AskJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Jarvis"
    static let description = IntentDescription("Asks Jarvis on your Mac and gives you the reply.")

    @Parameter(title: "Request", requestValueDialog: IntentDialog("What should I ask Jarvis?"))
    var request: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Jarvis \(\.$request)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = await IntentRunner.ask(request, client: .live())
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct BriefMeIntent: AppIntent {
    static let title: LocalizedStringResource = "Brief me"
    static let description = IntentDescription("Your briefing from Jarvis: the day ahead, and what needs you.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let briefing = await IntentRunner.brief(client: .live())
        return .result(value: briefing, dialog: "\(briefing)")
    }
}

struct WhatDidIMissIntent: AppIntent {
    static let title: LocalizedStringResource = "What did I miss"
    static let description = IntentDescription("Texts, emails and calls from the last day, as Jarvis summarized them.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let digest = await IntentRunner.whatDidIMiss(client: .live())
        return .result(value: digest, dialog: "\(digest)")
    }
}

struct StopJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Jarvis"
    static let description = IntentDescription("Stops what Jarvis is saying or doing on your Mac.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: "\(await IntentRunner.run(.stop, client: .live()))")
    }
}

struct StartMeetingNotesIntent: AppIntent {
    static let title: LocalizedStringResource = "Start meeting notes"
    static let description = IntentDescription("Jarvis takes notes of the meeting on your Mac.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: "\(await IntentRunner.run(.meetingStart(title: "Meeting"), client: .live()))")
    }
}

struct StopMeetingNotesIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop meeting notes"
    static let description = IntentDescription("Stops the meeting notes, and Jarvis writes them up.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: "\(await IntentRunner.run(.meetingStop, client: .live()))")
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor { .navy }

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskJarvisIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something", "Talk to \(.applicationName)"],
            shortTitle: "Ask Jarvis", systemImageName: "sparkle"
        )
        AppShortcut(
            intent: BriefMeIntent(),
            phrases: ["Brief me with \(.applicationName)", "\(.applicationName) brief me", "Get my briefing from \(.applicationName)"],
            shortTitle: "Brief me", systemImageName: "sparkles"
        )
        AppShortcut(
            intent: WhatDidIMissIntent(),
            phrases: ["What did I miss in \(.applicationName)", "Ask \(.applicationName) what I missed"],
            shortTitle: "What did I miss", systemImageName: "tray.full"
        )
        AppShortcut(
            intent: StopJarvisIntent(),
            phrases: ["Stop \(.applicationName)"],
            shortTitle: "Stop Jarvis", systemImageName: "stop.fill"
        )
        AppShortcut(
            intent: StartMeetingNotesIntent(),
            phrases: ["Start meeting notes in \(.applicationName)", "Take meeting notes with \(.applicationName)"],
            shortTitle: "Start meeting notes", systemImageName: "note.text"
        )
        AppShortcut(
            intent: StopMeetingNotesIntent(),
            phrases: ["Stop meeting notes in \(.applicationName)"],
            shortTitle: "Stop meeting notes", systemImageName: "record.circle"
        )
    }
}
