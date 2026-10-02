// jarvis-duplex: JARVIS's voice and the microphone through one AVAudioEngine with Apple's
// voice processing on (the echo cancellation FaceTime uses), so the microphone hears the
// room without JARVIS's own voice in it, and the owner can talk over JARVIS.
//
//   jarvis-duplex <sample-rate> --live [--effect] --capture-fd <fd> [--input builtin|default]
//
// Playback is jarvis-player's live mode, frame for frame (the voice must go through this
// engine: its output is the echo canceller's reference). Frames on stdin (little-endian):
//
//   'A' <u32 n> <n bytes of PCM>   play this audio after whatever is queued
//   'M' <u32 id>                   print "M <id>" once everything before it has played
//   'S' <u32 0>                    stop now: drop everything queued (barge-in)
//   'V' <u32 permille>             the voice's volume, 0-1000 (lowered while you talk over it)
//
// The microphone, echo cancelled, goes to <fd> as 16 kHz mono 16-bit PCM, as it comes
// (a write that would block is dropped: Jarvis reading late never stalls the audio).
// stdout lines: "M <id>" as above; "R" when the output device changed and queued audio
// was lost; "C <input name>" once the first cancelled audio is on its way; "E <why>" when
// it can't do this (it exits then, and Jarvis goes back to its usual microphone).
//
// --input builtin (Jarvis's default): only the Mac's own microphone. With AirPods as the
// Mac's input it exits instead: opening their microphone would drop them into call quality.
//
// Other apps' sound isn't turned down while this runs (voice processing ducks it by
// default: that's set to the minimum, with advanced ducking off).
//
// Built with swiftc -parse-as-library (duplex.py, through audio.build).

import AVFoundation
import CoreAudio
import Foundation

let stdoutLock = NSLock()
func say(_ line: String) {
    stdoutLock.lock()
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    stdoutLock.unlock()
}

func fail(_ why: String, _ code: Int32) -> Never {
    say("E " + why.replacingOccurrences(of: "\n", with: " "))
    exit(code)
}

// ── the Mac's input device ──

func defaultInput() -> AudioDeviceID? {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    return status == noErr && device != 0 ? device : nil
}

func deviceName(_ device: AudioDeviceID) -> String {
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return "?" }
    return name.takeRetainedValue() as String
}

func isBuiltIn(_ device: AudioDeviceID) -> Bool {
    var transport = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr else { return false }
    return transport == kAudioDeviceTransportTypeBuiltIn
}

// ── capture ──

final class Capture: @unchecked Sendable {
    let fd: Int32
    let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    var converter: AVAudioConverter?
    var mono: AVAudioFormat?
    var told = false
    var dropped = 0

    init(fd: Int32) {
        self.fd = fd
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }

    /// The input's format changed (a new device, voice processing's own choice): convert
    /// from it now. Voice processing's cancelled signal is its first channel.
    func use(_ format: AVAudioFormat) {
        mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
        converter = mono.flatMap { AVAudioConverter(from: $0, to: target) }
    }

    func take(_ buffer: AVAudioPCMBuffer, name: String) {
        guard let mono, let converter, let channels = buffer.floatChannelData, buffer.frameLength > 0,
              let single = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength)
        else { return }
        single.frameLength = buffer.frameLength
        single.floatChannelData![0].update(from: channels[0], count: Int(buffer.frameLength))
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / mono.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return single
        }
        guard error == nil, out.frameLength > 0 else { return }
        let bytes = Int(out.frameLength) * 2
        let written = write(fd, out.int16ChannelData![0], bytes)
        if written < 0 {
            if errno == EPIPE { exit(0) }  // Jarvis closed its end: nobody is listening
            dropped += 1  // EAGAIN: Jarvis is reading late; this piece is dropped
        }
        if !told {
            told = true
            say("C " + name)
        }
    }
}

// ── the engine ──

@main
struct Duplex {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        let rate = Double(args.count > 1 ? args[1] : "24000") ?? 24000
        let effect = args.contains("--effect")
        guard let at = args.firstIndex(of: "--capture-fd"), at + 1 < args.count, let fd = Int32(args[at + 1]) else {
            fail("no --capture-fd", 2)
        }
        let builtinOnly = !(args.firstIndex(of: "--input").map { $0 + 1 < args.count && args[$0 + 1] == "default" } ?? false)

        guard let input = defaultInput() else { fail("the Mac has no microphone", 5) }
        let inputName = deviceName(input)
        if builtinOnly && !isBuiltIn(input) {
            fail("the Mac's input is \(inputName), not its own microphone", 5)
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        do {
            try inputNode.setVoiceProcessingEnabled(true)
        } catch {
            fail("voice processing couldn't start: \(error.localizedDescription)", 4)
        }
        inputNode.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)

        let player = AVAudioPlayerNode()
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else {
            fail("bad sample rate", 2)
        }
        engine.attach(player)
        var tail: AVAudioNode = player
        if effect {
            // jarvis-player's effect: a tight doubled voice, a small room, trimmed lows and highs.
            let delay = AVAudioUnitDelay()
            delay.delayTime = 0.011
            delay.feedback = 0
            delay.wetDryMix = 22
            delay.lowPassCutoff = 8000
            let reverb = AVAudioUnitReverb()
            reverb.loadFactoryPreset(.smallRoom)
            reverb.wetDryMix = 10
            let eq = AVAudioUnitEQ(numberOfBands: 2)
            eq.bands[0].filterType = .highPass
            eq.bands[0].frequency = 140
            eq.bands[0].bypass = false
            eq.bands[1].filterType = .lowPass
            eq.bands[1].frequency = 7500
            eq.bands[1].bypass = false
            let convert = AVAudioMixerNode()
            let hardwareRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
            guard let studio = AVAudioFormat(standardFormatWithSampleRate: hardwareRate > 0 ? hardwareRate : 48000, channels: 2) else {
                fail("no output format", 3)
            }
            for node in [convert, delay, reverb, eq] as [AVAudioNode] { engine.attach(node) }
            engine.connect(player, to: convert, format: format)
            engine.connect(convert, to: delay, format: studio)
            engine.connect(delay, to: reverb, format: studio)
            engine.connect(reverb, to: eq, format: studio)
            engine.connect(eq, to: engine.mainMixerNode, format: studio)
            tail = eq
        }
        if tail === player { engine.connect(player, to: engine.mainMixerNode, format: format) }

        let capture = Capture(fd: fd)
        func listen() {
            let hardware = inputNode.outputFormat(forBus: 0)
            capture.use(hardware)
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in
                capture.take(buffer, name: inputName)
            }
        }
        listen()
        engine.prepare()
        do { try engine.start() } catch { fail("the audio engine didn't start: \(error.localizedDescription)", 3) }
        player.play()

        // A new device stops the engine: listen again with its format, start again, and
        // say queued audio is gone. The player is stopped and played again too: after the
        // engine restarts, play() alone leaves it saying it plays while it takes no buffer
        // (jarvis-player's sentence markers then never came back).
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
            listen()
            do { try engine.start() } catch { return }
            player.stop()
            player.play()
            say("R")
        }

        // The voice's volume moves over 40 ms, not at once (no click).
        let volumeQueue = DispatchQueue(label: "volume")
        var volumeTarget: Float = 1
        func setVolume(_ value: Float) {
            volumeQueue.async {
                volumeTarget = value
                let start = player.volume
                for step in 1...8 {
                    if volumeTarget != value { return }
                    player.volume = start + (value - start) * Float(step) / 8
                    usleep(5000)
                }
            }
        }

        let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1)!
        silence.frameLength = 1
        silence.floatChannelData![0][0] = 0

        func pcmBuffer(_ bytes: Data) -> AVAudioPCMBuffer? {
            let frames = bytes.count / 2
            guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
            buffer.frameLength = AVAudioFrameCount(frames)
            let out = buffer.floatChannelData![0]
            bytes.withUnsafeBytes { raw in
                let samples = raw.bindMemory(to: Int16.self)
                for i in 0..<frames { out[i] = Float(Int16(littleEndian: samples[i])) / 32768.0 }
            }
            return buffer
        }

        let stdin = FileHandle.standardInput
        var pending = Data()
        var leftover = Data()
        reading: while true {
            let data = stdin.availableData
            if data.isEmpty { break }
            pending.append(data)
            while pending.count >= 5 {
                let kind = pending[pending.startIndex]
                let value = pending.subdata(in: (pending.startIndex + 1)..<(pending.startIndex + 5))
                    .withUnsafeBytes { $0.load(as: UInt32.self) }
                let n = UInt32(littleEndian: value)
                if kind == UInt8(ascii: "A") {
                    let total = 5 + Int(n)
                    if pending.count < total { continue reading }
                    var audio = leftover + pending.subdata(in: (pending.startIndex + 5)..<(pending.startIndex + total))
                    pending.removeSubrange(pending.startIndex..<(pending.startIndex + total))
                    if audio.count % 2 == 1 {
                        leftover = audio.suffix(1)
                        audio = audio.dropLast()
                    } else {
                        leftover = Data()
                    }
                    if let buffer = pcmBuffer(audio) { player.scheduleBuffer(buffer, completionHandler: nil) }
                } else if kind == UInt8(ascii: "M") {
                    pending.removeSubrange(pending.startIndex..<(pending.startIndex + 5))
                    leftover = Data()
                    let id = n
                    player.scheduleBuffer(silence, completionCallbackType: .dataPlayedBack) { _ in say("M \(id)") }
                } else if kind == UInt8(ascii: "S") {
                    pending.removeSubrange(pending.startIndex..<(pending.startIndex + 5))
                    leftover = Data()
                    player.stop()
                    if engine.isRunning { player.play() }  // (play() on a stopped engine traps)
                } else if kind == UInt8(ascii: "V") {
                    pending.removeSubrange(pending.startIndex..<(pending.startIndex + 5))
                    setVolume(Float(min(n, 1000)) / 1000)
                } else {
                    pending.removeAll()  // out of step: drop it rather than play noise
                }
            }
        }
        inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        exit(0)
    }
}
