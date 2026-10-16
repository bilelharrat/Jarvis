import AVFoundation
import Foundation
import Observation
import Speech

/// Dictation into the composer: Apple's speech recognition, on the iPhone when it can
/// (requiresOnDeviceRecognition when the language supports it), the words shown as they come.
/// Nothing is sent until the owner taps send.
@MainActor
@Observable
final class Dictation {
    private(set) var listening = false
    private(set) var problem: String?
    /// The words heard so far this time.
    private(set) var heard = ""

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer()

    func toggle() async {
        if listening { stop() } else { await start() }
    }

    func start() async {
        problem = nil
        heard = ""
        let speech = await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        guard speech == .authorized else {
            problem = "Turn on Speech Recognition for Eden Code in Settings › Privacy & Security."
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            problem = "Turn on the microphone for Eden Code in Settings › Privacy & Security."
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            problem = "Dictation isn’t available right now."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            request.addsPunctuation = true
            self.request = request
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
            listening = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let text = result?.bestTranscription.formattedString
                let final = result?.isFinal ?? false
                Task { @MainActor in
                    guard let self else { return }
                    if let text { self.heard = text }
                    if error != nil || final { self.stop() }
                }
            }
        } catch {
            problem = "Couldn’t start the microphone."
            stop()
        }
    }

    func stop() {
        guard listening || request != nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Spoken review: a reply, a step list or a diff read aloud with the iPhone's own voice
/// (AVSpeechSynthesizer), so the owner can review while walking. Code is read as words:
/// symbols that mean nothing aloud are dropped, and a diff says "added" and "removed".
@MainActor
@Observable
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()

    private let synthesizer = AVSpeechSynthesizer()
    /// What's being read (an id the screen chose), so its button shows Stop.
    private(set) var speaking: String?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func toggle(_ text: String, id: String) {
        if speaking == id {
            stop()
        } else {
            speak(text, id: id)
        }
    }

    func speak(_ text: String, id: String) {
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: Self.spoken(text))
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier) ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speaking = id
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        speaking = nil
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = nil }
    }

    /// Text as it reads well aloud: Markdown marks and code fences out, long paths shortened
    /// to their file names.
    nonisolated static func spoken(_ text: String) -> String {
        var out = text.replacingOccurrences(of: "```", with: " ")
        for mark in ["**", "__", "`", "#"] { out = out.replacingOccurrences(of: mark, with: "") }
        out = out.replacingOccurrences(of: #"(?:[\w.-]+/)+([\w.-]+)"#, with: "$1", options: .regularExpression)
        return out.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ". ")
    }

    /// A file's change, read aloud: "In share.js, line 41: removed: const url equals …; added: …".
    nonisolated static func spoken(file: PhoneChanges.File) -> String {
        var parts = ["In \((file.path as NSString).lastPathComponent), \(file.added) added, \(file.removed) removed."]
        for hunk in file.hunks.prefix(6) {
            let lines = hunk.lines.filter { $0.kind != .context }.prefix(8).map { line in
                "\(line.kind == .added ? "added" : "removed"): \(line.text.trimmingCharacters(in: .whitespaces))"
            }
            parts.append("Change \(hunk.n), line \(hunk.newStart). " + lines.joined(separator: ". "))
        }
        return parts.joined(separator: " ")
    }
}
