import AVFoundation
import Speech

/// "Hey Jarvis": on-device speech recognition listening for the name, while the owner has it
/// on. Recognition never leaves the iPhone (it runs only where on-device recognition is
/// supported) and nothing is kept: each stretch is thrown away unless it holds the name.
/// "Hey Jarvis" alone starts listening for a request; "Hey Jarvis, what's next?" in one
/// breath sends what came after the name straight away.
///
/// iOS lets an app listen only while it's in front, or in the background while its audio
/// session stays active (the orange dot shows), until a call, Siri or another app takes the
/// microphone. For the Lock Screen and a phone in a pocket, Settings explains Vocal Shortcuts
/// ("Hey Jarvis" trained in iOS itself), which needs none of this.
@MainActor
@Observable
final class WakeWordListener {
    private(set) var isListening = false
    /// The name was heard and nothing followed it.
    var onWake: (() -> Void)?
    /// The name was heard with a request after it.
    var onCommand: ((String) -> Void)?

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var cycle: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var heardName: Date?
    @ObservationIgnored private var lastChange = Date()
    @ObservationIgnored private var latest = ""
    @ObservationIgnored private var interruption: NSObjectProtocol?

    /// Recognition restarts this often, so a long stretch never runs into a limit.
    static let stretch: TimeInterval = 50
    /// After the name, this much quiet ends the request.
    static let pause: TimeInterval = 1.1
    nonisolated static let names = ["jarvis", "jarvus", "jervis", "travis jarvis"]

    func start() {
        guard !isListening else { return }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVAudioApplication.shared.recordPermission == .granted else { return }
        isListening = true
        observeInterruptions()
        begin()
    }

    func stop() {
        guard isListening else { return }
        isListening = false
        generation += 1
        cycle?.cancel()
        cycle = nil
        teardown()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Asks for the microphone and speech recognition, for the Settings switch.
    static func authorize() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    /// Whether this iPhone can recognise speech on-device (wake words never go to a server).
    static var supported: Bool {
        (SFSpeechRecognizer(locale: Locale(identifier: "en-US")))?.supportsOnDeviceRecognition ?? false
    }

    private func begin() {
        guard isListening else { return }
        teardown()
        generation += 1
        let generation = generation
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.supportsOnDeviceRecognition else {
            isListening = false
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = true
            request.contextualStrings = ["Jarvis", "Hey Jarvis", "OK Jarvis"]
            request.taskHint = .search

            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw CocoaError(.featureUnsupported) }
            input.installTap(onBus: 0, bufferSize: 2048, format: format, block: Self.tap(feeding: request))
            engine.prepare()
            try engine.start()
            task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] text, ended in
                Task { @MainActor in self?.heard(text, ended: ended, generation: generation) }
            })
            self.engine = engine
            self.request = request
            heardName = nil
            latest = ""
        } catch {
            // The microphone is busy (a call, another app): try again shortly.
            teardown()
        }
        cycle?.cancel()
        cycle = Task { [weak self] in
            let started = Date()
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, self.generation == generation, self.isListening else { return }
                if let named = self.heardName, Date().timeIntervalSince(self.lastChange) > Self.pause, Date().timeIntervalSince(named) > 0.3 {
                    self.fire()
                    return
                }
                if self.engine == nil || (self.heardName == nil && Date().timeIntervalSince(started) > Self.stretch) {
                    self.begin()  // a fresh stretch (or another try at the microphone)
                    return
                }
            }
        }
    }

    nonisolated private static func tap(feeding request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    nonisolated private static func results(_ report: @escaping @Sendable (String, Bool) -> Void) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in
            report(result?.bestTranscription.formattedString ?? "", (result?.isFinal ?? false) || error != nil)
        }
    }

    private func heard(_ text: String, ended: Bool, generation: Int) {
        guard generation == self.generation, isListening else { return }
        if text != latest {
            latest = text
            lastChange = Date()
        }
        if heardName == nil, Self.afterName(in: text) != nil {
            heardName = Date()
        }
        if ended {
            if heardName != nil { fire() } else { engine = nil }  // the cycle starts a new stretch
        }
    }

    /// What was said after the name, if the name was said ("" when nothing followed it).
    nonisolated static func afterName(in text: String) -> String? {
        let lowered = text.lowercased()
        guard let range = names.compactMap({ lowered.range(of: $0) }).last else { return nil }
        let rest = String(text[range.upperBound...])
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        return rest
    }

    private func fire() {
        let command = Self.afterName(in: latest) ?? ""
        stop()
        if command.split(separator: " ").count >= 2 {
            onCommand?(command)
        } else {
            onWake?()
        }
    }

    private func teardown() {
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
    }

    private func observeInterruptions() {
        guard interruption == nil else { return }
        interruption = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .ended
            Task { @MainActor in
                guard let self, self.isListening else { return }
                if ended { self.begin() } else { self.teardown() }
            }
        }
    }
}
