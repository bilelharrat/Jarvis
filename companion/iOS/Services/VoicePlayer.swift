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

    init() {
        finishWatcher.onFinish = { [weak self] in self?.finished() }
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
        player = nil
        isPlaying = false
        deactivate()
    }

    private func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private final class FinishWatcher: NSObject, AVAudioPlayerDelegate {
    var onFinish: (@MainActor () -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }
}
