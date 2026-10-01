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
    /// Voice mode: the microphone stays open while it speaks (to hear the owner cut in), with
    /// the session's echo cancellation, and the session stays active between turns.
    @ObservationIgnored var duplex = false
    /// A reply spoken as it's written (voice mode): how much of it is queued, and whether
    /// the whole of it has come.
    @ObservationIgnored private var streamed = 0
    @ObservationIgnored private var streaming = false
    @ObservationIgnored private var streamDone = false
    @ObservationIgnored private var utterances = 0

    init() {
        finishWatcher.onFinish = { [weak self] in self?.finished() }
        finishWatcher.onUtterance = { [weak self] in self?.utteranceEnded() }
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
            try activate()
        } catch {
            return failed("Couldn’t play the reply.")
        }
        isPlaying = true
        utter(words)
    }

    private func utter(_ words: String) {
        let utterance = AVSpeechUtterance(string: words)
        utterance.voice = Self.bestVoice(for: Speakable.voiceLanguage(for: words))
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
        utterance.pitchMultiplier = 0.95
        utterances += 1
        synthesizer.speak(utterance)
    }

    /// The audio session for speaking: playback alone, or (voice mode) with the microphone
    /// open and echo cancelled.
    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        if duplex {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
        } else {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        }
        try session.setActive(true)
    }

    // MARK: - Speaking as it's written (voice mode)

    /// Feeds the reply so far: each finished sentence is spoken at once, in the iPhone's own
    /// voice; `final` speaks what's left. The first call starts a new reply.
    func stream(_ text: String, final: Bool) {
        if !streaming {
            stop()
            streaming = true
            streamed = 0
            streamDone = false
            do { try activate() } catch { return failed("Couldn’t play the reply.") }
        }
        let (pieces, next) = Self.sentences(in: text, from: streamed, final: final)
        streamed = next
        for piece in pieces {
            let words = Speakable.clean(piece)
            if !words.isEmpty {
                isPlaying = true
                utter(words)
            }
        }
        if final {
            streamDone = true
            if utterances == 0 { finished() }
        }
    }

    /// The finished sentences of `text` after `start` (all of it when final), and where the
    /// next one begins. A sentence ends at . ! ? or a line break followed by a space or the end,
    /// and is long enough to be worth saying alone (short ones join the next).
    nonisolated static func sentences(in text: String, from start: Int, final: Bool) -> ([String], Int) {
        let characters = Array(text)
        guard start < characters.count else { return ([], start) }
        var pieces: [String] = []
        var begin = start
        var index = start
        while index < characters.count {
            let c = characters[index]
            let ends = ".!?。！？\n".contains(c)
            let followed = index + 1 >= characters.count ? false : characters[index + 1].isWhitespace
            if ends && (followed || c == "\n") {
                let piece = String(characters[begin...index]).trimmingCharacters(in: .whitespacesAndNewlines)
                if piece.count >= 12 || c == "\n" {
                    if !piece.isEmpty { pieces.append(piece) }
                    begin = index + 1
                }
            }
            index += 1
        }
        if final {
            let rest = String(characters[begin...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !rest.isEmpty { pieces.append(rest) }
            return (pieces, characters.count)
        }
        return (pieces, begin)
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
        streaming = false
        streamDone = false
        utterances = 0
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
            try activate()
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

    /// A clip or an utterance ended (an utterance per sentence when streaming).
    private func utteranceEnded() {
        utterances = max(0, utterances - 1)
        if utterances > 0 { return }
        if streaming && !streamDone { return }  // more of the reply is on its way
        finished()
    }

    private func finished() {
        streaming = false
        streamDone = false
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
        guard !duplex else { return }  // voice mode listens next, on the same session
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private final class FinishWatcher: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    var onFinish: (@MainActor () -> Void)?
    var onUtterance: (@MainActor () -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let onUtterance = onUtterance
        Task { @MainActor in onUtterance?() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let onFinish = onFinish
        Task { @MainActor in onFinish?() }
    }
}
