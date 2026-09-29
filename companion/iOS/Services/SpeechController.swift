import Accelerate
import AVFoundation
import Speech

/// Tap to talk: live transcription with the Speech framework (on-device when the phone
/// supports it). Ends on about 1.2 s of silence, a second tap, or a minute's talking.
@MainActor
@Observable
final class SpeechController {
    enum Status: Equatable {
        case idle, starting, listening, finishing
    }

    enum Problem: LocalizedError {
        case speechDenied, microphoneDenied, unavailable, noMicrophone

        var errorDescription: String? {
            switch self {
            case .speechDenied: "Speech Recognition is off for J.A.R.V.I.S. You can turn it on in Settings, or type instead."
            case .microphoneDenied: "The microphone is off for J.A.R.V.I.S. You can turn it on in Settings, or type instead."
            case .unavailable: "Speech recognition isn’t available right now. Type your request instead."
            case .noMicrophone: "No microphone is available right now."
            }
        }

        /// Fixed in the Settings app.
        var needsSettings: Bool { self == .speechDenied || self == .microphoneDenied }
    }

    private(set) var status: Status = .idle
    /// What it has heard so far.
    private(set) var transcript = ""
    /// Input level, 0...1, for the reactor.
    private(set) var level: Double = 0

    static let silence: TimeInterval = 1.2
    static let nothingHeard: TimeInterval = 8
    static let longest: TimeInterval = 60

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var watchdog: Task<Void, Never>?
    @ObservationIgnored private var onDone: ((String) -> Void)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var startedAt = Date()
    @ObservationIgnored private var lastWords = Date()
    @ObservationIgnored private var lastLoud = Date()

    var isActive: Bool { status != .idle }

    /// Start listening; `onDone` gets the transcript (possibly empty) when it ends by itself
    /// or through `finish()`. Not called after `cancel()`.
    func start(onDone: @escaping (String) -> Void) async throws {
        guard status == .idle else { return }
        status = .starting
        do {
            try await Self.authorize()
            guard status == .starting else { return }  // cancelled while asking
            self.onDone = onDone
            try begin()
        } catch {
            teardown()
            status = .idle
            throw error
        }
    }

    /// The second tap: stop listening and hand over what was heard.
    func finish() {
        guard status == .listening else { return }
        status = .finishing
        stopAudio()
        request?.endAudio()
        let generation = generation
        Task { [weak self] in  // the final result usually lands well inside this
            try? await Task.sleep(for: .milliseconds(1500))
            self?.deliver(generation)
        }
    }

    func cancel() {
        guard status != .idle else { return }
        generation += 1
        onDone = nil
        teardown()
        status = .idle
    }

    // MARK: - Recognition

    private func begin() throws {
        guard let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { throw Problem.unavailable }

        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
        try audio.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Problem.noMicrophone }

        generation += 1
        let generation = generation
        let meter = LevelMeter { [weak self] level in
            Task { @MainActor in self?.heard(level: level, generation: generation) }
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(feeding: request, meter: meter))
        engine.prepare()
        try engine.start()

        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] text, final, failed in
            Task { @MainActor in self?.recognized(text, final: final, failed: failed, generation: generation) }
        })
        self.engine = engine
        self.request = request
        transcript = ""
        level = 0
        startedAt = Date()
        lastWords = Date()
        lastLoud = Date()
        status = .listening
        watch(generation)
    }

    /// Built outside the main actor: the audio engine calls it on its own thread.
    nonisolated private static func tap(feeding request: SFSpeechAudioBufferRecognitionRequest, meter: LevelMeter) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
            meter.feed(buffer)
        }
    }

    nonisolated private static func results(_ report: @escaping @Sendable (String?, Bool, Bool) -> Void) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in
            report(result?.bestTranscription.formattedString, result?.isFinal ?? false, error != nil)
        }
    }

    nonisolated private static func authorize() async throws {
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { throw Problem.speechDenied }
        guard await AVAudioApplication.requestRecordPermission() else { throw Problem.microphoneDenied }
    }

    private func recognized(_ text: String?, final: Bool, failed: Bool, generation: Int) {
        guard generation == self.generation, status == .listening || status == .finishing else { return }
        if let text, !text.isEmpty, text != transcript {
            transcript = text
            lastWords = Date()
        }
        if final || failed {
            deliver(generation)
        }
    }

    private func heard(level value: Double, generation: Int) {
        guard generation == self.generation, status == .listening else { return }
        level = value
        if value > 0.35 { lastLoud = Date() }
    }

    /// Ends on silence: no new words and a quiet mic for `silence`, or no new words for
    /// a while even with noise around.
    private func watch(_ generation: Int) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == generation, self.status == .listening else { return }
                let now = Date()
                let quietWords = now.timeIntervalSince(self.lastWords)
                let quietMic = now.timeIntervalSince(self.lastLoud)
                if self.transcript.isEmpty {
                    if now.timeIntervalSince(self.startedAt) > Self.nothingHeard { self.finish() }
                } else if (quietWords > Self.silence && quietMic > Self.silence) || quietWords > Self.silence * 2.5 {
                    self.finish()
                }
                if now.timeIntervalSince(self.startedAt) > Self.longest { self.finish() }
            }
        }
    }

    private func deliver(_ generation: Int) {
        guard generation == self.generation, status == .listening || status == .finishing else { return }
        let text = transcript.trimmed
        let done = onDone
        onDone = nil
        self.generation += 1
        teardown()
        status = .idle
        done?(text)
    }

    private func teardown() {
        watchdog?.cancel()
        watchdog = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func stopAudio() {
        guard let engine else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        self.engine = nil
    }
}

/// Microphone loudness (RMS in dBFS mapped to 0...1), computed on the audio thread.
private final class LevelMeter: @unchecked Sendable {
    private let report: @Sendable (Double) -> Void
    private var count = 0

    init(report: @escaping @Sendable (Double) -> Void) {
        self.report = report
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        count += 1
        guard count % 2 == 0, let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(buffer.frameLength))
        let decibels = 20 * log10(max(rms, 0.000_001))
        report(Double(max(0, min(1, (decibels + 55) / 45))))  // -55 dB is silence, -10 dB loud
    }
}
