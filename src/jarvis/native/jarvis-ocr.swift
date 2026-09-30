// jarvis-ocr: the text in images and screenshots, read on this Mac by Apple's Vision
// (VNRecognizeTextRequest, accurate, Simplified Chinese and English, with language
// correction), for the second brain. Built by jarvis.ocr with swiftc on first use and cached
// by this file's hash.
//
//   jarvis-ocr serve    JSON lines in, {"id": 1, "path": "/Users/…/Screenshot.png"}; one line
//                       out for each: {"id": 1, "text": "…"} (lines top to bottom) or
//                       {"id": 1, "error": "why"}. Ends when its input does.
//
// Only reads the files it's given; never writes, never goes online.

import Foundation
import Vision

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func recognize(_ path: String) -> (String?, String) {
    let url = URL(fileURLWithPath: path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Chinese first: its model reads English too, the English one doesn't read Chinese.
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(url: url, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return (nil, error.localizedDescription)
    }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return (lines.joined(separator: "\n"), "")
}

func serve() {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            continue
        }
        let id = item["id"] ?? NSNull()
        guard let path = item["path"] as? String, !path.isEmpty else {
            emit(["id": id, "error": "no path"])
            continue
        }
        let (text, why) = autoreleasepool { recognize(path) }
        if let text {
            emit(["id": id, "text": String(text.prefix(20000))])
        } else {
            emit(["id": id, "error": why])
        }
    }
}

if CommandLine.arguments.dropFirst().first == "serve" {
    serve()
} else {
    FileHandle.standardError.write("usage: jarvis-ocr serve\n".data(using: .utf8)!)
    exit(2)
}
