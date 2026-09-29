// jarvis-player: plays JARVIS's voice as it arrives.
//
//   jarvis-player <sample-rate> [--effect]           one clip: raw 16-bit LE mono PCM on
//                                                    stdin until EOF, then exit
//   jarvis-player <sample-rate> [--effect] --live    stays running: framed messages on
//                                                    stdin, events on stdout
//
// Live mode is what makes replies seamless: the audio engine is already running when the
// first words arrive, and sentence after sentence plays back to back with no process to
// start, no engine to spin up and no buffering in between. Frames (little-endian):
//
//   'A' <u32 n> <n bytes of PCM>   play this audio after whatever is queued
//   'M' <u32 id>                   print "M <id>" once everything before it has played
//   'S' <u32 0>                    stop now: drop everything queued (barge-in)
//
// It prints "R" if the output device changed and queued audio was lost.
//
// AVAudioEngine follows the current output device (AirPods switching modes, a new
// default output), which PortAudio did not. --effect adds the "AI in the house" sheen
// natively: a tight doubled voice, a small room, trimmed lows and highs.

import AVFoundation
import Foundation

let args = CommandLine.arguments
let rate = Double(args.count > 1 ? args[1] : "24000") ?? 24000
let effect = args.contains("--effect")
let live = args.contains("--live")

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else {
    exit(2)
}
engine.attach(player)
var tail: AVAudioNode = player
if effect {
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
    // Effect units only take the engine's standard format, so a mixer converts the mono
    // voice to stereo at the hardware rate first.
    let convert = AVAudioMixerNode()
    let hardwareRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
    guard let studio = AVAudioFormat(standardFormatWithSampleRate: hardwareRate > 0 ? hardwareRate : 48000, channels: 2) else { exit(2) }
    for node in [convert, delay, reverb, eq] as [AVAudioNode] { engine.attach(node) }
    engine.connect(player, to: convert, format: format)
    engine.connect(convert, to: delay, format: studio)
    engine.connect(delay, to: reverb, format: studio)
    engine.connect(reverb, to: eq, format: studio)
    engine.connect(eq, to: engine.mainMixerNode, format: studio)
    tail = eq
}
if tail === player { engine.connect(player, to: engine.mainMixerNode, format: format) }
do { try engine.start() } catch { exit(3) }

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

let stdout = FileHandle.standardOutput
let outLock = NSLock()
func emit(_ line: String) {
    outLock.lock()
    stdout.write((line + "\n").data(using: .utf8)!)
    outLock.unlock()
}

if live {
    player.play()  // idle but running: the first buffer plays the moment it's scheduled

    // A new output device stops the engine: start it again and say queued audio is gone.
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
        try? engine.start()
        player.play()
        emit("R")
    }

    let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1)!
    silence.frameLength = 1
    silence.floatChannelData![0][0] = 0

    let input = FileHandle.standardInput
    var pending = Data()
    var leftover = Data()  // an odd byte of PCM carried to the next audio frame
    readLoop: while true {
        let data = input.availableData
        if data.isEmpty { break }
        pending.append(data)
        while pending.count >= 5 {
            let kind = pending[pending.startIndex]
            let value = pending.subdata(in: (pending.startIndex + 1)..<(pending.startIndex + 5))
                .withUnsafeBytes { $0.load(as: UInt32.self) }
            let n = UInt32(littleEndian: value)
            if kind == UInt8(ascii: "A") {
                let total = 5 + Int(n)
                if pending.count < total { continue readLoop }
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
                // A sentence ends on a whole sample. A byte still waiting here is half of
                // one from a stream cut off mid-sentence: kept, it would shift every later
                // sentence by a byte, into full-scale static.
                leftover = Data()
                let id = n
                player.scheduleBuffer(silence, completionCallbackType: .dataPlayedBack) { _ in emit("M \(id)") }
            } else if kind == UInt8(ascii: "S") {
                pending.removeSubrange(pending.startIndex..<(pending.startIndex + 5))
                leftover = Data()
                player.stop()  // drops queued buffers (their markers still report)
                player.play()
            } else {
                pending.removeAll()  // out of step: drop it rather than play noise
            }
        }
    }
    player.stop()
    engine.stop()
    exit(0)
}

let pendingGroup = DispatchGroup()
var started = false

func schedule(_ bytes: Data) {
    guard let buffer = pcmBuffer(bytes) else { return }
    pendingGroup.enter()
    player.scheduleBuffer(buffer) { pendingGroup.leave() }
    if !started {
        started = true
        player.play()
    }
}

// One clip: buffer a little before starting so a slow first packet doesn't stutter, then
// play in ~100 ms pieces as they arrive.
let startBytes = Int(rate * 0.25) * 2
let pieceBytes = Int(rate * 0.1) * 2
var buffered = Data()
let input = FileHandle.standardInput
while true {
    let data = input.availableData
    if data.isEmpty { break }
    buffered.append(data)
    let threshold = started ? pieceBytes : startBytes
    if buffered.count >= threshold {
        let usable = buffered.count - buffered.count % 2
        schedule(buffered.prefix(usable))
        buffered = Data(buffered.suffix(from: buffered.startIndex + usable))
    }
}
if buffered.count >= 2 { schedule(buffered.prefix(buffered.count - buffered.count % 2)) }
pendingGroup.wait()
if effect { usleep(250_000) } // let the room tail ring out
engine.stop()
