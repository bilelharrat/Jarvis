// jarvis-hear: Apple's on-device speech recognition (SpeechAnalyzer + SpeechTranscriber,
// macOS 26+) for Jarvis's hands-free listening. It never opens the microphone: Jarvis
// hands it the utterances it already hears.
//
//   jarvis-hear status <en|zh>    one JSON line: {"available", "locale", "installed"}
//   jarvis-hear size <en|zh>      one JSON line: {"bytes"} the model download would be
//   jarvis-hear install <en|zh>   downloads Apple's model for the language: JSON lines
//                                 {"progress": 0..1} then {"done": true} (or {"error"})
//   jarvis-hear listen <en|zh>    stays running: framed audio and requests on stdin,
//                                 JSON lines on stdout
//
// Listen frames (little-endian, as jarvis-player's):
//   'B' <u32 0>             an utterance begins: what follows is heard afresh
//   'A' <u32 n> <n bytes>   16 kHz mono 16-bit PCM of the utterance, in order
//   'F' <u32 n> <n bytes>   JSON {"id", "start", "end"}: the words heard in [start, end),
//                           answered {"t": "done", "id", "text"}
//   'C' <u32 n> <n bytes>   JSON {"strings": [...]}: words to listen for (names, wake words)
// Positions count the samples of every 'A' so far.
//
// Each utterance gets an analyzer of its own: fed as one stream, the model took a new
// utterance for the rest of the last sentence and heard its first word ("Jarvis") as a
// comma. A request closes the utterance's analyzer and gives it a second of quiet (in
// microphone-sized buffers: one big buffer stalled it), which finalizes its words in about
// 0.2 s; audio after that point, if the speaker carries on, goes to a new analyzer.
//
// It prints {"t": "ready", "locale"} once the model is loaded, then {"t": "partial" |
// "final", "start", "end", "text"} as words are heard, and {"t": "error", "why"} when
// something fails. Nothing leaves the Mac.
//
// Built with swiftc -parse-as-library (stt_apple.ensure_helper).

import AVFoundation
import CoreMedia
import Foundation
import Speech

let rate: Double = 16000
let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outLock.lock()
    out.write(data)
    out.write("\n".data(using: .utf8)!)
    outLock.unlock()
}

func samples(_ time: CMTime) -> Int64 {
    guard time.isValid, !time.isIndefinite else { return 0 }
    return Int64((time.seconds * rate).rounded())
}

func wantedLocale(_ code: String) async -> Locale? {
    if code == "zh" {
        return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "zh-CN"))
    }
    // English as the Mac speaks it (en-GB, en-AU…), else American English.
    let mine = Locale.current
    if mine.language.languageCode?.identifier == "en",
       let found = await SpeechTranscriber.supportedLocale(equivalentTo: mine) {
        return found
    }
    return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))
}

func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange]
    )
}

func isInstalled(_ locale: Locale) async -> Bool {
    let installed = await SpeechTranscriber.installedLocales
    let wanted = locale.identifier(.bcp47)
    return installed.contains { $0.identifier(.bcp47) == wanted }
}

// ── the words of a result that fall in a stretch of audio ──

struct Heard {
    let start: Int64
    let end: Int64
    let text: AttributedString
}

/// The words in [start, end): each word by the middle of its audio; spaces and marks
/// between two words kept go with them.
func spoken(in results: [Heard], from start: Int64, to end: Int64) -> String {
    var pieces: [String] = []
    for result in results where result.end > start && result.start < end {
        var pending = ""
        var inside = false
        for run in result.text.runs {
            let piece = String(result.text[run.range].characters)
            if let range = run.audioTimeRange {
                let middle = samples(range.start) + samples(range.duration) / 2
                inside = middle >= start && middle < end
                if inside {
                    pieces.append(pending + piece)
                }
                pending = ""
            } else if inside {
                pending += piece
            }
        }
        if inside, !pending.isEmpty { pieces.append(pending) }
        pieces.append(" ")
    }
    return pieces.joined().replacingOccurrences(of: "  ", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// ── listening ──

let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!

/// One utterance's analyzer. Its times count from its own first sample. Owned by Hearing:
/// only ever touched on that actor.
final class Utterance: @unchecked Sendable {
    let start: Int64  // where it began, in samples of the whole stream
    let analyzer: SpeechAnalyzer
    let transcriber: SpeechTranscriber
    let inputs: AsyncStream<AnalyzerInput>
    let builder: AsyncStream<AnalyzerInput>.Continuation
    let converter: AVAudioConverter?
    let format: AVAudioFormat
    var fed: Int64 = 0  // its samples so far, the quiet added at the end included
    var heard: Int64 = 0  // its samples of the speaker's audio
    var closed = false
    var finals: [Heard] = []
    var results: Task<Void, Never>?

    init(start: Int64, transcriber: SpeechTranscriber, format: AVAudioFormat) {
        self.start = start
        self.transcriber = transcriber
        self.format = format
        (inputs, builder) = AsyncStream<AnalyzerInput>.makeStream()
        analyzer = SpeechAnalyzer(
            modules: [transcriber],
            options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
        )
        converter = format == pcm16 ? nil : AVAudioConverter(from: pcm16, to: format)
    }

    /// 16-bit PCM in, 800 samples (50 ms) at a time at most.
    func feed(_ data: Data, speaker: Bool = true) {
        let total = data.count / 2
        var offset = 0
        while offset < total {
            let count = min(800, total - offset)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: pcm16, frameCapacity: AVAudioFrameCount(count)) else { return }
            buffer.frameLength = AVAudioFrameCount(count)
            data.withUnsafeBytes { raw in
                let from = raw.bindMemory(to: Int16.self)
                let to = buffer.int16ChannelData![0]
                for i in 0..<count { to[i] = Int16(littleEndian: from[offset + i]) }
            }
            let at = CMTime(value: fed, timescale: CMTimeScale(rate))
            fed += Int64(count)
            if speaker { heard += Int64(count) }
            offset += count
            if let converter {
                let capacity = AVAudioFrameCount(Double(count) * format.sampleRate / rate) + 32
                guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { continue }
                var given = false
                var error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if given {
                        status.pointee = .noDataNow
                        return nil
                    }
                    given = true
                    status.pointee = .haveData
                    return buffer
                }
                if error == nil, converted.frameLength > 0 {
                    builder.yield(AnalyzerInput(buffer: converted, bufferStartTime: at))
                }
            } else {
                builder.yield(AnalyzerInput(buffer: buffer, bufferStartTime: at))
            }
        }
    }

}

/// Every utterance's state is read and changed on this actor only.
actor Hearing {
    let locale: Locale
    let format: AVAudioFormat
    var utterances: [Utterance] = []
    var position: Int64 = 0  // samples of the speaker's audio so far
    var strings: [String] = []

    init(locale: Locale, format: AVAudioFormat) {
        self.locale = locale
        self.format = format
    }

    /// A new utterance's analyzer, ready to hear.
    func open() async -> Utterance? {
        let utterance = Utterance(start: position, transcriber: makeTranscriber(locale), format: format)
        do {
            try await utterance.analyzer.prepareToAnalyze(in: format)
            if !strings.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = strings
                try await utterance.analyzer.setContext(context)
            }
            try await utterance.analyzer.start(inputSequence: utterance.inputs)
        } catch {
            emit(["t": "error", "why": "start: \(error.localizedDescription)"])
            return nil
        }
        utterance.results = Task { [transcriber = utterance.transcriber] in
            do {
                for try await result in transcriber.results { self.heard(result, in: utterance) }
            } catch {}
        }
        utterances.append(utterance)
        // An utterance whose words were given long ago isn't asked about again.
        while utterances.count > 8, let old = utterances.first, old.closed {
            utterances.removeFirst()
            await end(old)
        }
        return utterance
    }

    func heard(_ result: SpeechTranscriber.Result, in utterance: Utterance) {
        let start = samples(result.range.start)
        let end = samples(result.range.end)
        if result.isFinal {
            utterance.finals.append(Heard(start: start, end: end, text: result.text))
        }
        emit([
            "t": result.isFinal ? "final" : "partial",
            "start": utterance.start + start,
            "end": utterance.start + min(end, utterance.heard),
            "text": String(result.text.characters),
        ])
    }

    func begin() {
        utterances.last?.closed = true  // the next audio opens a new one
    }

    func feed(_ data: Data) async {
        var current = utterances.last
        if current == nil || current!.closed {
            current = await open()
        }
        current?.feed(data)
        position += Int64(data.count / 2)
    }

    /// The words in [start, end) of the whole stream, from each utterance's analyzer that
    /// heard any of it.
    func words(id: Int, start: Int64, end: Int64) async {
        var texts: [String] = []
        for utterance in utterances where utterance.start < end && utterance.start + utterance.heard > start {
            await finalize(utterance, through: end - utterance.start)
            let text = spoken(in: utterance.finals, from: start - utterance.start, to: end - utterance.start)
            if !text.isEmpty { texts.append(text) }
        }
        emit(["t": "done", "id": id, "text": texts.joined(separator: " ")])
    }

    func context(_ strings: [String]) async {
        self.strings = Array(strings.prefix(100))
        guard let current = utterances.last, !current.closed else { return }
        let context = AnalysisContext()
        context.contextualStrings[.general] = self.strings
        try? await current.analyzer.setContext(context)
    }

    /// An utterance's words through `through` (its own time), final: closed, and a second
    /// of quiet after what it heard so the model finishes its last words.
    func finalize(_ utterance: Utterance, through: Int64) async {
        if !utterance.closed {
            utterance.closed = true
            utterance.feed(Data(count: 16000 * 2), speaker: false)
        }
        let point = CMTime(value: max(0, min(through, utterance.heard)), timescale: CMTimeScale(rate))
        do {
            try await utterance.analyzer.finalize(through: point)
        } catch {
            emit(["t": "error", "why": "finalize: \(error.localizedDescription)"])
        }
        try? await Task.sleep(nanoseconds: 60_000_000)  // the results on their way land
    }

    func end(_ utterance: Utterance) async {
        utterance.builder.finish()
        await utterance.analyzer.cancelAndFinishNow()
        utterance.results?.cancel()
    }

    func finish() async {
        for utterance in utterances { await end(utterance) }
    }
}

func listen(_ code: String) async -> Int32 {
    guard SpeechTranscriber.isAvailable else {
        emit(["t": "error", "why": "Apple's speech recognition isn't available on this Mac"])
        return 4
    }
    guard let locale = await wantedLocale(code) else {
        emit(["t": "error", "why": "Apple's speech recognition doesn't support this language"])
        return 4
    }
    guard await isInstalled(locale) else {
        emit(["t": "error", "why": "Apple's speech model for \(locale.identifier(.bcp47)) isn't on this Mac"])
        return 5
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [makeTranscriber(locale)]) else {
        emit(["t": "error", "why": "no audio format for the speech model"])
        return 4
    }
    let hearing = Hearing(locale: locale, format: format)
    // The first analyzer loads the model (seconds, once); later ones start in milliseconds.
    guard await hearing.open() != nil else { return 4 }
    emit(["t": "ready", "locale": locale.identifier(.bcp47)])

    // stdin, read on its own thread; frames handled in order.
    let (frames, frameBuilder) = AsyncStream<(UInt8, Data)>.makeStream()
    Thread.detachNewThread {
        let input = FileHandle.standardInput
        var pending = Data()
        reading: while true {
            let data = input.availableData
            if data.isEmpty { break }
            pending.append(data)
            while pending.count >= 5 {
                let kind = pending[pending.startIndex]
                let size = pending.subdata(in: (pending.startIndex + 1)..<(pending.startIndex + 5))
                    .withUnsafeBytes { $0.load(as: UInt32.self) }
                let total = 5 + Int(UInt32(littleEndian: size))
                guard "ABFC".utf8.contains(kind), total <= 16_000_000 else {
                    emit(["t": "error", "why": "out of step with Jarvis"])
                    break reading
                }
                if pending.count < total { break }
                let body = pending.subdata(in: (pending.startIndex + 5)..<(pending.startIndex + total))
                pending.removeSubrange(pending.startIndex..<(pending.startIndex + total))
                frameBuilder.yield((kind, body))
            }
        }
        frameBuilder.finish()
    }
    for await (kind, body) in frames {
        switch kind {
        case UInt8(ascii: "A"):
            await hearing.feed(body)
        case UInt8(ascii: "B"):
            await hearing.begin()
        case UInt8(ascii: "F"):
            guard let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let id = (request["id"] as? NSNumber)?.intValue,
                  let start = (request["start"] as? NSNumber)?.int64Value,
                  let end = (request["end"] as? NSNumber)?.int64Value
            else { continue }
            await hearing.words(id: id, start: start, end: end)
        default:
            if let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let strings = request["strings"] as? [String] {
                await hearing.context(strings)
            }
        }
    }
    await hearing.finish()
    return 0
}

// ── the model on this Mac ──

func status(_ code: String) async -> Int32 {
    guard let locale = await wantedLocale(code) else {
        emit(["available": SpeechTranscriber.isAvailable, "locale": "", "installed": false])
        return 0
    }
    emit([
        "available": SpeechTranscriber.isAvailable,
        "locale": locale.identifier(.bcp47),
        "installed": await isInstalled(locale),
    ])
    return 0
}

/// What macOS would download for the language (nil: nothing, it's installed). A language
/// this app hasn't used may need a place reserved for it first.
func installationRequest(_ locale: Locale) async throws -> AssetInstallationRequest? {
    let modules: [any SpeechModule] = [makeTranscriber(locale)]
    do {
        return try await AssetInventory.assetInstallationRequest(supporting: modules)
    } catch {
        guard (try? await AssetInventory.reserve(locale: locale)) == true else { throw error }
        return try await AssetInventory.assetInstallationRequest(supporting: modules)
    }
}

func size(_ code: String) async -> Int32 {
    guard let locale = await wantedLocale(code) else {
        emit(["error": "Apple's speech recognition doesn't support this language"])
        return 4
    }
    do {
        guard let request = try await installationRequest(locale) else {
            emit(["bytes": 0, "installed": true])
            return 0
        }
        emit(["bytes": request.progress.totalUnitCount])
    } catch {
        emit(["error": error.localizedDescription])
        return 4
    }
    return 0
}

func install(_ code: String) async -> Int32 {
    guard let locale = await wantedLocale(code) else {
        emit(["error": "Apple's speech recognition doesn't support this language"])
        return 4
    }
    do {
        guard let request = try await installationRequest(locale) else {
            emit(["done": true])
            return 0
        }
        let watch = Task {
            while !Task.isCancelled {
                emit(["progress": request.progress.fractionCompleted, "bytes": request.progress.totalUnitCount])
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        try await request.downloadAndInstall()
        watch.cancel()
        emit(["done": true])
    } catch {
        emit(["error": error.localizedDescription])
        return 4
    }
    return 0
}

// The main thread stays free (an async main, not a wait on it): the speech framework
// delivers some of its work there, and blocking it held finalize() up for seconds.
@main
struct Hear {
    static func main() async {
        let args = CommandLine.arguments
        let code = args.count > 2 ? args[2] : "en"
        var exitCode: Int32 = 2
        switch args.count > 1 ? args[1] : "" {
        case "status": exitCode = await status(code)
        case "size": exitCode = await size(code)
        case "install": exitCode = await install(code)
        case "listen": exitCode = await listen(code)
        default: emit(["error": "usage: jarvis-hear status|size|install|listen en|zh"])
        }
        exit(exitCode)
    }
}
