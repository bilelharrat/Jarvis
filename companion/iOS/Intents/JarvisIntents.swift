import AppIntents
import Foundation
import SwiftUI

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
        let reply = await IntentRunner.ask(request, client: .live(), local: IntentRunner.phoneAnswer)
        return .result(value: reply, dialog: "\(reply)")
    }
}

/// "Jarvis", and then what you want: hands-free from a Vocal Shortcut (iOS listens for the
/// word itself, locked or not), Siri, the Action Button or Back Tap. Asks "Yes?", answers
/// with the Mac (or Jarvis on the iPhone when the Mac can't be reached) and says the reply in
/// the JARVIS voice, without opening the app; Siri reads it only when that voice can't.
struct JarvisHandsFreeIntent: AppIntent {
    static let title: LocalizedStringResource = "Jarvis"
    static let description = IntentDescription("Say “Jarvis”, then what you want. Jarvis answers out loud in its own voice, even with your iPhone locked. Make it a Vocal Shortcut to call Jarvis by name anytime.")

    @Parameter(title: "Request", requestValueDialog: IntentDialog("Yes?"))
    var request: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
        let reply = await IntentRunner.ask(request, client: .live(), local: IntentRunner.phoneAnswer)
        let mac = PairingStore.load().flatMap { $0.isPinned ? $0.api : nil }
        if let clips = await JarvisVoice.clips(for: reply, mac: mac) {
            // Its own voice, carrying on after Siri's sheet goes: Siri stays quiet.
            ClipQueue.shared.play(clips)
            return .result(value: reply, dialog: IntentDialog(full: "", supporting: ""), view: ReplySnippet(text: reply))
        }
        return .result(value: reply, dialog: "\(reply)", view: ReplySnippet(text: reply))
    }
}

/// The reply as Siri's sheet shows it.
struct ReplySnippet: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            OrbMark(size: 18)
            Text(text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
    }
}

struct BriefMeIntent: AppIntent {
    static let title: LocalizedStringResource = "Brief me"
    static let description = IntentDescription("Your briefing from Jarvis: the day ahead, and what needs you.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let briefing = await IntentRunner.brief(client: .live(), local: IntentRunner.phoneAnswer)
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
            intent: JarvisHandsFreeIntent(),
            phrases: ["\(.applicationName)", "Hey \(.applicationName)", "OK \(.applicationName)"],
            shortTitle: "Jarvis", systemImageName: "waveform.circle"
        )
        AppShortcut(
            intent: TalkToJarvisIntent(),
            phrases: ["Talk to \(.applicationName)", "Open \(.applicationName) and listen", "\(.applicationName) listen"],
            shortTitle: "Talk to Jarvis", systemImageName: "waveform"
        )
        AppShortcut(
            intent: AskJarvisIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something", "Ask \(.applicationName) a question"],
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
