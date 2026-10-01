import AVFoundation
import Speech

/// Voice mode's ear while Jarvis speaks: the owner talking over the reply stops it, as in the
/// ChatGPT, Gemini and Claude apps' voice modes. The microphone runs with the session's echo
/// cancellation (voice processing), and on-device recognition listens; Jarvis's own words
/// leaking back in don't count: it's the owner only when what's heard isn't the reply.
@MainActor
final class BargeIn {
    /// The owner started talking.
    var onSpeech: (() -> Void)?

    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    /// What Jarvis is saying (so its echo isn't taken for the owner).
    private var reply = ""

    var isListening: Bool { engine != nil }

    /// Listens while `reply` is spoken; quietly does nothing when the microphone or
    /// recognition can't be had (tapping still interrupts).
    func start(reply: String) {
        self.reply = reply
        guard engine == nil,
              SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVAudioApplication.shared.recordPermission == .granted,
              let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        try? input.setVoiceProcessingEnabled(true)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(feeding: request))
        engine.prepare()
        do { try engine.start() } catch { input.removeTap(onBus: 0); return }
        generation += 1
        let generation = generation
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] heard in
            Task { @MainActor in self?.heard(heard, generation: generation) }
        })
        self.engine = engine
        self.request = request
    }

    /// More of the reply is being said.
    func update(reply: String) { self.reply = reply }

    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            try? engine.inputNode.setVoiceProcessingEnabled(false)
        }
        engine = nil
    }

    private func heard(_ text: String, generation: Int) {
        guard generation == self.generation, Self.isOwner(heard: text, reply: reply) else { return }
        stop()
        onSpeech?()
    }

    /// Whether what the microphone heard is the owner rather than Jarvis's own voice coming
    /// back: at least two words, most of which the reply doesn't say.
    nonisolated static func isOwner(heard: String, reply: String) -> Bool {
        let words = Self.words(heard)
        guard words.count >= 2 else { return false }
        let said = Set(Self.words(reply))
        let new = words.filter { !said.contains($0) }
        return Double(new.count) / Double(words.count) > 0.5
    }

    nonisolated static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber && $0 != "'" }.map(String.init)
    }

    nonisolated private static func tap(feeding request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    nonisolated private static func results(_ report: @escaping @Sendable (String) -> Void) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, _ in
            if let text = result?.bestTranscription.formattedString, !text.isEmpty { report(text) }
        }
    }
}
