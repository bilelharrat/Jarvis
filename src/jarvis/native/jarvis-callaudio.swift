// jarvis-callaudio: what the Mac plays (the other side of a call) for call notes, captured
// by ScreenCaptureKit as audio only. Built by jarvis.features.proactive.calls with swiftc on
// first use and cached by this file's hash.
//
//   jarvis-callaudio [pid …]   16 kHz mono signed 16-bit little-endian PCM on stdout, the
//                              sound of every app but the pids given (JARVIS's own voice);
//                              one JSON line on stderr: {"ready": true} once it's listening,
//                              or {"error": "no_permission" | "no_display" | "why"}.
//
// It stops when its input closes (the notes stopped, or the app quit) or on SIGTERM. It
// needs Screen Recording for J.A.R.V.I.S. (macOS asks once). No picture is kept: the stream
// is set to 2 by 2 pixels once a second and its frames are never read. Never writes files,
// never goes online.

import CoreMedia
import Foundation
import ScreenCaptureKit

func status(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let out = FileHandle.standardOutput
    private(set) var stream: SCStream?

    func start(excluding pids: Set<pid_t>) async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                status(["error": "no_display"])
                exit(2)
            }
            let own = content.applications.filter { pids.contains($0.processID) }
            let filter = SCContentFilter(
                display: display, excludingApplications: own, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 16_000
            config.channelCount = 1
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 3
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(
                self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "callaudio"))
            try await stream.startCapture()
            self.stream = stream
            status(["ready": true])
        } catch {
            let err = error as NSError
            let declined = err.domain == SCStreamErrorDomain
                && err.code == SCStreamError.userDeclined.rawValue
            status(["error": declined ? "no_permission" : err.localizedDescription])
            exit(3)
        }
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        var list = AudioBufferList()
        var block: CMBlockBuffer?
        let got = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &list,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &block)
        guard got == noErr, let raw = list.mBuffers.mData else { return }
        let count = Int(list.mBuffers.mDataByteSize) / MemoryLayout<Float>.size
        guard count > 0 else { return }
        let floats = raw.bindMemory(to: Float.self, capacity: count)
        var pcm = Data(count: count * 2)
        pcm.withUnsafeMutableBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for i in 0..<count {
                let value = max(-1, min(1, floats[i]))
                samples[i] = Int16(value * 32_767).littleEndian
            }
        }
        do {
            try out.write(contentsOf: pcm)
        } catch {
            exit(0)  // the app stopped reading: the notes are over
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        status(["error": (error as NSError).localizedDescription])
        exit(4)
    }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in exit(0) }
let pids = Set(CommandLine.arguments.dropFirst().compactMap { pid_t($0) })
let capture = Capture()
Task { await capture.start(excluding: pids) }
// When the input closes, the notes are over.
DispatchQueue.global().async {
    while !FileHandle.standardInput.availableData.isEmpty {}
    capture.stream?.stopCapture { _ in exit(0) }
    DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(0) }
}
dispatchMain()
