import AVFoundation
import Foundation

/// The JARVIS voice, wherever the iPhone is: the Mac's own (`/api/say`, the voice set up
/// there) while it can be reached, else askeden.com's hosted JARVIS voice (the same Fish
/// voice the Mac app uses without a key of its own, within a daily allowance per install, or
/// per Jarvis account when the owner is signed in).
/// nil means neither could speak it; the caller uses the iPhone's own voice.
enum JarvisVoice {
    static let hostedURL = URL(string: "https://askeden.com/api/voice")!
    /// askeden.com takes at most this many characters a request.
    static let hostedLimit = 600
    private static let installKey = "voice.install-id"

    /// This install's id for the hosted voice's daily allowance (not a secret; nothing about
    /// the owner is in it).
    static var installID: String {
        if let id = UserDefaults.standard.string(forKey: installKey), id.count == 32 { return id }
        let id = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        UserDefaults.standard.set(id, forKey: installKey)
        return id
    }

    /// The reply as WAV clips in the JARVIS voice, in order.
    static func clips(for text: String, mac: JarvisAPI?) async -> [Data]? {
        let words = Speakable.clean(text)
        guard !words.isEmpty else { return nil }
        if let mac, let wav = try? await mac.say(words) {
            return [wav]
        }
        var clips: [Data] = []
        for piece in pieces(of: words) {
            guard let wav = try? await hosted(piece) else { return clips.isEmpty ? nil : clips }
            clips.append(wav)
        }
        return clips.isEmpty ? nil : clips
    }

    static func hosted(_ text: String) async throws -> Data {
        var request = URLRequest(url: hostedURL, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(installID, forHTTPHeaderField: "X-Jarvis-Install")
        if let token = AccountKeychain.token {  // counted against the account's allowance instead
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "format": "wav"])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count > 44 else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    /// Sentences gathered into pieces askeden.com takes whole.
    static func pieces(of text: String) -> [String] {
        var pieces: [String] = []
        var current = ""
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sentence, _, _, _ in
            guard let sentence else { return }
            if current.count + sentence.count > hostedLimit, !current.isEmpty {
                pieces.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            }
            current += sentence
            while current.count > hostedLimit {  // one sentence longer than a request
                let head = String(current.prefix(hostedLimit))
                pieces.append(head)
                current = String(current.dropFirst(hostedLimit))
            }
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { pieces.append(current.trimmingCharacters(in: .whitespaces)) }
        return pieces
    }
}

/// Plays clips one after another, outside any screen (Siri and Vocal Shortcuts), with the
/// audio session the app's background audio mode keeps alive while it plays.
@MainActor
final class ClipQueue: NSObject, AVAudioPlayerDelegate {
    static let shared = ClipQueue()

    private var clips: [Data] = []
    private var player: AVAudioPlayer?

    func play(_ clips: [Data]) {
        stop()
        self.clips = clips
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return
        }
        next()
    }

    func stop() {
        player?.stop()
        player = nil
        clips = []
    }

    private func next() {
        while !clips.isEmpty {
            let wav = clips.removeFirst()
            if let player = try? AVAudioPlayer(data: wav) {
                player.delegate = self
                self.player = player
                if player.play() { return }
            }
        }
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.next() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.next() }
    }
}
