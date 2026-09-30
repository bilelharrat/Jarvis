import AVFoundation
import Foundation

/// Replies spoken on the wrist, in JARVIS's own voice when the Mac can make it
/// (POST /api/say, a WAV), else the Watch's own voice in the reply's language. Only replies
/// to what was asked here, only while the app is frontmost, and only with Speak replies on.
/// No model calls: the Mac renders the voice, the Watch only plays it.
@MainActor
@Observable
final class WatchVoice {
    private(set) var speaking = false

    /// Speak replies, on this Watch (the iPhone has its own switch).
    var enabled: Bool {
        get { setting }
        set {
            setting = newValue
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            if !newValue { stop() }
        }
    }

    private var setting: Bool
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var fetch: Task<Void, Never>?
    /// Bumped by every reply and every stop, so a voice fetched for an older one is dropped.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private let watcher = SpeechWatcher()

    private static let enabledKey = "speakReplies"

    init() {
        setting = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
        #if DEBUG
        if let speak = DebugLaunch.speak { setting = speak }  // this launch only
        #endif
        watcher.onFinish = { [weak self] in self?.settle() }
        synthesizer.delegate = watcher
    }

    func speak(_ text: String, using api: JarvisAPI) {
        stop()
        let words = Speakable.clean(text)
        guard enabled, !words.isEmpty else { return }
        speaking = true  // fetching counts: Stop cuts it off too
        let turn = generation
        fetch = Task { [weak self] in
            let wav: Data?
            do {
                wav = try await api.say(words)
            } catch is CancellationError {
                return
            } catch {
                wav = nil  // the Mac can't voice it now: the Watch's own voice
            }
            guard let self, self.generation == turn else { return }
            self.fetch = nil
            if let wav {
                self.play(wav, orSay: words)
            } else {
                self.sayHere(words)
            }
        }
    }

    func stop() {
        generation += 1
        fetch?.cancel()
        fetch = nil
        player?.stop()
        player = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        if speaking { end() }
    }

    private func play(_ wav: Data, orSay words: String) {
        do {
            try activate()
            let player = try AVAudioPlayer(data: wav)
            player.delegate = watcher
            guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
            self.player = player
        } catch {
            sayHere(words)
        }
    }

    private func sayHere(_ words: String) {
        do {
            try activate()
        } catch {
            return end()
        }
        let utterance = AVSpeechUtterance(string: words)
        // No voice for that language on this Watch: nil, its default voice.
        utterance.voice = AVSpeechSynthesisVoice(language: Speakable.voiceLanguage(for: words))
        synthesizer.speak(utterance)
    }

    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
    }

    /// A WAV or an utterance ended. One that was stopped reports late, after a newer reply
    /// may have started, so this ends only when nothing is fetching or sounding.
    private func settle() {
        guard speaking, fetch == nil, player?.isPlaying != true, !synthesizer.isSpeaking else { return }
        end()
    }

    private func end() {
        player = nil
        speaking = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Hears when the WAV or the Watch's own voice is done.
private final class SpeechWatcher: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    var onFinish: (@MainActor () -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        done()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        done()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        done()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        done()
    }

    private func done() {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }
}
