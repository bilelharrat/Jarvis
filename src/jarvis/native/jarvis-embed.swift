// jarvis-embed: vectors for text from Apple's on-device language models (NaturalLanguage's
// NLContextualEmbedding), for the second brain's search by meaning. Built by
// jarvis.embeddings with swiftc on first use and cached by this file's hash.
//
//   jarvis-embed status   {"models": [{"language": "en", "model": "…", "dimension": 512,
//                          "available": true}, …]}: the models for English (Latin script,
//                          20 languages) and Chinese (with Japanese and Korean), and whether
//                          their files are on this Mac. Never downloads anything.
//   jarvis-embed assets   asks macOS for those models' files (a download the first time,
//                          only after the owner turns Search by meaning on); one line per
//                          model: {"language": "en", "result": "available"|"notAvailable"|
//                          "error", "error": "…"}.
//   jarvis-embed serve    JSON lines in, {"id": 1, "text": "…"}; one line out for each:
//                          {"id": 1, "model": "…", "v": "<base64 float32, little-endian>"}
//                          or {"id": 1, "skip": "why"}. Ends when its input does.
//
// A text's vector: the mean of its tokens' vectors (the model's own special tokens left out),
// made unit length. Measured on ~1,200-character passages and short questions that share no
// words with them, that ranked the right passage highest more often than the special first
// token, the mean with it, the max, or NLEmbedding's sentence vectors (8/15 first and 10/12 in
// the top five, against 4/15, 3/15 and 1/15 first). Texts past the model's 256 tokens are cut
// there.

import Foundation
import NaturalLanguage

let modelLanguages: [NLLanguage] = [.english, .simplifiedChinese]
let cjk: Set<NLLanguage> = [.simplifiedChinese, .traditionalChinese, .japanese, .korean]

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func describe(_ language: NLLanguage) -> [String: Any] {
    guard let model = NLContextualEmbedding(language: language) else {
        return ["language": language.rawValue, "available": false, "missing": true]
    }
    return [
        "language": language.rawValue,
        "model": model.modelIdentifier,
        "dimension": model.dimension,
        "available": model.hasAvailableAssets,
    ]
}

func requestAssets() {
    for language in modelLanguages {
        guard let model = NLContextualEmbedding(language: language) else {
            emit(["language": language.rawValue, "result": "notAvailable"])
            continue
        }
        if model.hasAvailableAssets {
            emit(["language": language.rawValue, "result": "available"])
            continue
        }
        var finished = false
        var outcome: [String: Any] = ["language": language.rawValue]
        model.requestAssets { result, error in
            switch result {
            case .available: outcome["result"] = "available"
            case .notAvailable: outcome["result"] = "notAvailable"
            case .error: outcome["result"] = "error"
            @unknown default: outcome["result"] = "error"
            }
            if let error { outcome["error"] = error.localizedDescription }
            finished = true
        }
        // The answer comes on another queue; the main run loop keeps turning meanwhile.
        let deadline = Date().addingTimeInterval(45 * 60)
        while !finished && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        }
        if !finished { outcome["result"] = "error"; outcome["error"] = "timed out" }
        emit(outcome)
    }
}

final class Embedder {
    var loaded: [String: NLContextualEmbedding] = [:]
    var failed: [String: String] = [:]

    func model(for language: NLLanguage) -> (NLContextualEmbedding?, String) {
        let wanted: NLLanguage = cjk.contains(language) ? .simplifiedChinese : language
        guard let model = NLContextualEmbedding(language: wanted) ?? NLContextualEmbedding(language: .english) else {
            return (nil, "no model")
        }
        let id = model.modelIdentifier
        if let ready = loaded[id] { return (ready, "") }
        if let why = failed[id] { return (nil, why) }
        guard model.hasAvailableAssets else {
            failed[id] = "no-assets"
            return (nil, "no-assets")
        }
        do {
            try model.load()
        } catch {
            failed[id] = "load failed: \(error.localizedDescription)"
            return (nil, failed[id]!)
        }
        loaded[id] = model
        return (model, "")
    }

    func vector(_ text: String) -> ([Float]?, String, String) {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let language = recognizer.dominantLanguage ?? .english
        let (found, why) = model(for: language)
        guard let model = found else { return (nil, "", why) }
        let result: NLContextualEmbeddingResult
        do {
            // The language when the model knows it; a short query read as some other one
            // ("Q3 budget") is left to the model.
            let hint: NLLanguage? = model.languages.contains(language) ? language : nil
            result = try model.embeddingResult(for: text, language: hint)
        } catch {
            return (nil, "", "error: \(error.localizedDescription)")
        }
        let size = model.dimension
        var sum = [Double](repeating: 0, count: size)
        var count = 0.0
        result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { values, range in
            if range.isEmpty { return true }  // a special token of the model's, not the text's
            for i in 0..<min(size, values.count) { sum[i] += values[i] }
            count += 1
            return true
        }
        let norm = sum.reduce(0) { $0 + $1 * $1 }.squareRoot()
        guard count > 0, norm > 0 else { return (nil, "", "no tokens") }
        return (sum.map { Float($0 / norm) }, model.modelIdentifier, "")
    }
}

func serve() {
    let embedder = Embedder()
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            continue
        }
        let id = item["id"] ?? NSNull()
        let text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            emit(["id": id, "skip": "empty"])
            continue
        }
        let (vector, model, why) = embedder.vector(String(text.prefix(2000)))
        guard let vector else {
            emit(["id": id, "skip": why])
            continue
        }
        let bytes = vector.withUnsafeBufferPointer { Data(buffer: $0) }
        emit(["id": id, "model": model, "v": bytes.base64EncodedString()])
    }
}

let command = CommandLine.arguments.dropFirst().first ?? ""
switch command {
case "status":
    emit(["models": modelLanguages.map(describe)])
case "assets":
    requestAssets()
case "serve":
    serve()
default:
    FileHandle.standardError.write("usage: jarvis-embed status | assets | serve\n".data(using: .utf8)!)
    exit(2)
}
