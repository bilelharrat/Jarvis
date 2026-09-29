// jarvis-player: plays raw 16-bit little-endian mono PCM from stdin as it arrives.
//
//   jarvis-player <sample-rate> [--effect]
//
// AVAudioEngine follows the current output device (AirPods switching modes, a new default
// output), which PortAudio did not. --effect adds the "AI in the house" sheen natively:
// a tight doubled voice, a small room, trimmed lows and highs.

import AVFoundation
import Foundation

let args = CommandLine.arguments
let rate = Double(args.count > 1 ? args[1] : "24000") ?? 24000
let effect = args.contains("--effect")

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

let pending = DispatchGroup()
var started = false

func schedule(_ bytes: Data) {
    let frames = bytes.count / 2
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    let out = buffer.floatChannelData![0]
    bytes.withUnsafeBytes { raw in
        let samples = raw.bindMemory(to: Int16.self)
        for i in 0..<frames { out[i] = Float(Int16(littleEndian: samples[i])) / 32768.0 }
    }
    pending.enter()
    player.scheduleBuffer(buffer) { pending.leave() }
    if !started {
        started = true
        player.play()
    }
}

// Buffer a little before starting so a slow first packet doesn't stutter, then play in
// ~100 ms pieces as they arrive.
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
pending.wait()
if effect { usleep(250_000) } // let the room tail ring out
engine.stop()
