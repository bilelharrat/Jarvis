import AVFoundation

/// Plays replies in JARVIS's own voice: POST /api/say returns a WAV rendered on the Mac.
@MainActor
@Observable
final class VoicePlayer {
    private(set) var isPlaying = false
    /// Why the last reply couldn't be spoken (the text is on screen regardless).
    var onProblem: ((String) -> Void)?

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var fetch: Task<Void, Never>?
    @ObservationIgnored private let finishWatcher = FinishWatcher()
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    /// Called when a reply has finished playing (to listen for "Hey Jarvis" again).
    @ObservationIgnored var onFinish: (() -> Void)?

    init() {
        finishWatcher.onFinish = { [weak self] in self?.finished() }
        synthesizer.delegate = finishWatcher
    }

    /// The rest of a reply in the hosted JARVIS voice, played one clip after another.
    @ObservationIgnored private var queued: [Data] = []

    /// Says it without the Mac: in the JARVIS voice from askeden.com when it answers, else
    /// in the iPhone's own best voice.
    func speakLocally(_ text: String) {
        stop()
        let words = Speakable.clean(text)
        guard !words.isEmpty else { return }
        isPlaying = true
        fetch = Task { [weak self] in
            let clips = await JarvisVoice.clips(for: words, mac: nil)
            guard !Task.isCancelled, let self else { return }
            if let clips, !clips.isEmpty {
                self.queued = Array(clips.dropFirst())
                self.play(clips[0])
            } else {
                self.speakWithSystemVoice(words)
            }
        }
    }

    /// The iPhone's own best voice: a British voice for English, the highest quality installed.
    private func speakWithSystemVoice(_ words: String) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return failed("Couldn’t play the reply.")
        }
        let utterance = AVSpeechUtterance(string: words)
        utterance.voice = Self.bestVoice(for: Speakable.voiceLanguage(for: words))
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
        utterance.pitchMultiplier = 0.95
        isPlaying = true
        synthesizer.speak(utterance)
    }

    static func bestVoice(for language: String) -> AVSpeechSynthesisVoice? {
        let english = language.hasPrefix("en")
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { voice in
            english ? voice.language.hasPrefix("en") : voice.language.hasPrefix(String(language.prefix(2)))
        }
        func score(_ voice: AVSpeechSynthesisVoice) -> Int {
            var points = voice.quality == .premium ? 300 : voice.quality == .enhanced ? 200 : 0
            if english, voice.language == "en-GB" { points += 50 }
            if ["Arthur", "Daniel", "Jamie", "Oliver"].contains(where: voice.name.contains) { points += 20 }
            if voice.voiceTraits.contains(.isNoveltyVoice) { points -= 1000 }
            return points
        }
        return candidates.max { score($0) < score($1) } ?? AVSpeechSynthesisVoice(language: language)
    }

    func speak(_ text: String, using api: JarvisAPI) {
        stop()
        let words = Speakable.clean(text)
        guard !words.isEmpty else { return }
        isPlaying = true  // fetching counts: Stop should cut it off too
        fetch = Task { [weak self] in
            do {
                let wav = try await api.say(words)
                try Task.checkCancellation()
                self?.play(wav)
            } catch is CancellationError {
            } catch JarvisError.unavailable {
                self?.failed("Jarvis’s voice isn’t available on the Mac right now.")
            } catch {
                self?.failed("Couldn’t get Jarvis’s voice: \((error as? JarvisError)?.title ?? error.localizedDescription).")
            }
        }
    }

    func stop() {
        fetch?.cancel()
        fetch = nil
        queued = []
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        if let player {
            player.stop()
            self.player = nil
            deactivate()
        }
        if isPlaying { isPlaying = false }
    }

    private func play(_ wav: Data) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            let player = try AVAudioPlayer(data: wav)
            player.delegate = finishWatcher
            player.prepareToPlay()
            guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
            self.player = player
        } catch {
            failed("Couldn’t play Jarvis’s voice.")
        }
    }

    private func failed(_ message: String) {
        player = nil
        isPlaying = false
        deactivate()
        onProblem?(message)
    }

    private func finished() {
        if !queued.isEmpty {
            play(queued.removeFirst())
            return
        }
        player = nil
        isPlaying = false
        deactivate()
        onFinish?()
    }

    private func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private final class FinishWatcher: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    var onFinish: (@MainActor () -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }
}
