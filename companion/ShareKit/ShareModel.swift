import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// What was shared, read from the share sheet's item providers, and sending it to the Mac
/// (or keeping it for when the Mac is back).
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        case sent(String)
        case kept
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var item: ShareItem?
    /// What the preview shows: the link, the file's name, the text's start.
    private(set) var title = ""
    private(set) var preview: UIImage?
    var note = ""

    static let suggestions = ["Summarize this", "What are the key points?", "Remind me about this tomorrow"]

    private let providers: [NSItemProvider]
    private let finish: (Bool) -> Void

    init(providers: [NSItemProvider], finish: @escaping (Bool) -> Void) {
        self.providers = providers
        self.finish = finish
    }

    var pairingMissing: Bool { PairingStore.load()?.isPinned != true }

    // MARK: - Reading what was shared

    func load() async {
        do {
            guard let loaded = try await Self.read(providers) else {
                phase = .failed("J.A.R.V.I.S. can take links, text, photos and files.")
                return
            }
            item = loaded.item
            title = loaded.title
            preview = loaded.preview
            phase = pairingMissing ? .failed("Open J.A.R.V.I.S. and pair it with your Mac first.") : .ready
        } catch let error as ShareProblem {
            phase = .failed(error.message)
        } catch {
            phase = .failed("Couldn’t read what was shared.")
        }
    }

    struct Loaded {
        var item: ShareItem
        var title: String
        var preview: UIImage?
    }

    struct ShareProblem: Error {
        let message: String
    }

    /// The first thing that can go, in order: a web link, an image, some text, a file.
    static func read(_ providers: [NSItemProvider]) async throws -> Loaded? {
        // A web link. (Providers claim the URL types loosely: the scheme decides; a file
        // URL is a file, below.)
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await provider.loadURL(), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                return Loaded(item: ShareItem(kind: .url, url: url.absoluteString), title: url.absoluteString)
            }
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            let data = try await provider.data(for: .image)
            let fitted = try ShareSizing.fit(image: data)
            let name = ShareSizing.name(provider.suggestedName, fallback: "Photo", ext: fitted.ext ?? ShareSizing.imageExtension(of: fitted.data))
            return Loaded(item: ShareItem(kind: .image, name: name, data: fitted.data), title: name, preview: ShareSizing.thumbnail(of: fitted.data))
        }
        // Text before files: plain text is data too.
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }),
           let text = await provider.loadText(), !text.trimmed.isEmpty {
            let clipped = String(text.prefix(100_000))
            return Loaded(item: ShareItem(kind: .text, text: clipped), title: String(clipped.trimmed.prefix(160)))
        }
        // A file: a file URL, or data that isn't a link (a link's provider claims data too).
        if let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || ($0.hasItemConformingToTypeIdentifier(UTType.data.identifier) && !$0.hasItemConformingToTypeIdentifier(UTType.url.identifier))
        }) {
            let data: Data
            let loadedName: String?
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier), let url = await provider.loadURL(), url.isFileURL {
                data = try ShareSizing.read(url)  // the file itself, with its own name
                loadedName = url.lastPathComponent
            } else {
                (data, loadedName) = try await provider.file()
            }
            guard data.count <= ShareItem.maxBytes else {
                throw ShareProblem(message: ShareSizing.tooBig(data.count))
            }
            let name = ShareSizing.name(ShareSizing.fileName(suggested: provider.suggestedName, loaded: loadedName), fallback: "File", ext: nil)
            return Loaded(item: ShareItem(kind: .file, name: name, data: data), title: name)
        }
        return nil
    }

    // MARK: - Sending

    func send() async {
        guard var item, phase == .ready || isFailedSend else { return }
        item.note = note.trimmed.isEmpty ? nil : note.trimmed
        guard let pairing = PairingStore.load(), pairing.isPinned else {
            phase = .failed("Open J.A.R.V.I.S. and pair it with your Mac first.")
            return
        }
        phase = .sending
        do {
            let result = try await pairing.api.share(item)
            if result.asked {
                phase = .sent("Jarvis is on it. The answer will be in J.A.R.V.I.S.")
            } else if let saved = result.savedAs {
                phase = .sent("Saved on your Mac as \(saved).")
            } else {
                phase = .sent("Sent to your Mac.")
            }
            close(after: 1.2, done: true)
        } catch let error as JarvisError where error.neverDelivered {
            keep(item)
        } catch let error as JarvisError {
            phase = .failed(error.errorDescription ?? error.title)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private var isFailedSend: Bool {
        if case .failed = phase, item != nil, !pairingMissing { return true }
        return false
    }

    /// The Mac isn't reachable: the app sends it when it is (within the hour).
    private func keep(_ item: ShareItem) {
        do {
            try Outbox.shared.add(.share(item), payload: item.data)
            phase = .kept
            close(after: 2, done: true)
        } catch {
            phase = .failed("Your Mac isn’t reachable, and this couldn’t be kept to send later.")
        }
    }

    func cancel() {
        finish(false)
    }

    private func close(after seconds: Double, done: Bool) {
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            finish(done)
        }
    }
}

/// Keeping what's shared within what the Mac takes.
enum ShareSizing {
    static func tooBig(_ bytes: Int) -> String {
        "That file is \(megabytes(bytes)). Your Mac takes files up to 25 MB from here."
    }

    /// An image as it came when the Mac reads its kind and it fits; otherwise a JPEG (a TIFF,
    /// a RAW photo, a BMP; or one too big, scaled down until it fits). ImageIO makes it at
    /// the size wanted, so a big photo is never decoded whole in the share extension.
    static func fit(image data: Data) throws -> (data: Data, ext: String?) {
        if data.count <= ShareItem.maxBytes, macReadsPicture(data) { return (data, nil) }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            if data.count <= ShareItem.maxBytes { return (data, nil) }  // not a picture this iPhone reads either
            throw ShareModel.ShareProblem(message: "That image is too big to send.")
        }
        var side = 4096
        while side >= 1024 {
            if let jpeg = jpeg(from: source, longest: side), jpeg.count <= ShareItem.maxBytes {
                return (jpeg, "jpg")
            }
            side /= 2
        }
        throw ShareModel.ShareProblem(message: "That image is too big to send.")
    }

    /// The pictures the Mac takes as such (companion_api._picture_type): JPEG, PNG, GIF,
    /// HEIC and WebP.
    static func macReadsPicture(_ data: Data) -> Bool {
        let head = [UInt8](data.prefix(12))
        if head.starts(with: [0xFF, 0xD8, 0xFF]) || head.starts(with: [0x89, 0x50, 0x4E, 0x47]) || head.starts(with: Array("GIF8".utf8)) {
            return true
        }
        guard head.count == 12 else { return false }
        let box = String(decoding: head[4..<8], as: UTF8.self)
        let brand = String(decoding: head[8..<12], as: UTF8.self)
        if box == "ftyp" { return ["heic", "heix", "mif1", "heim"].contains(brand) }
        return head.starts(with: Array("RIFF".utf8)) && brand == "WEBP"
    }

    /// A JPEG of the picture at most `longest` pixels on its long side, the right way up.
    static func jpeg(from source: CGImageSource, longest: Int, quality: CGFloat = 0.85) -> Data? {
        guard let image = downsampled(source, longest: longest) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    /// What the share sheet shows: a thumbnail, never the whole picture decoded (a
    /// 24-megapixel photo is about 100 MB, and a share extension has little memory).
    static func thumbnail(of data: Data, longest: Int = 256) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = downsampled(source, longest: longest) else { return nil }
        return UIImage(cgImage: image)
    }

    private static func downsampled(_ source: CGImageSource, longest: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longest,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    static func scaled(_ image: UIImage, longest: CGFloat) -> UIImage? {
        let size = image.size
        let scale = min(1, longest / max(size.width, size.height, 1))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// A file name the Mac can keep: no folders, a sensible length, the right extension.
    static func name(_ suggested: String?, fallback: String, ext: String?) -> String {
        var base = (suggested ?? "").replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmed
        if base.isEmpty || base.hasPrefix(".") { base = fallback }
        base = String(base.prefix(120))
        if let ext {
            let stem = (base as NSString).deletingPathExtension
            return "\(stem.isEmpty ? fallback : stem).\(ext)"
        }
        return base
    }

    /// The system hands over a copy with a generic name ("PDF document.pdf"): the name the
    /// thing had wins, with the copy's extension when it has none.
    static func fileName(suggested: String?, loaded: String?) -> String? {
        guard let suggested = suggested?.trimmed, !suggested.isEmpty else { return loaded }
        guard (suggested as NSString).pathExtension.isEmpty,
              let ext = loaded.map({ ($0 as NSString).pathExtension }), !ext.isEmpty else { return suggested }
        return "\(suggested).\(ext)"
    }

    /// An image's type from its first bytes (a photo shared from Photos comes without a name).
    static func imageExtension(of data: Data) -> String? {
        let head = [UInt8](data.prefix(12))
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if head.starts(with: Array("GIF8".utf8)) { return "gif" }
        if head.count >= 12, String(decoding: head[4..<8], as: UTF8.self) == "ftyp" {
            let brand = String(decoding: head[8..<12], as: UTF8.self)
            if ["heic", "heix", "mif1", "msf1"].contains(brand) { return "heic" }
        }
        return nil
    }

    /// A shared file's bytes, refusing one too big before reading it all.
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= ShareItem.maxBytes else {
            throw ShareModel.ShareProblem(message: tooBig(size))
        }
        return try Data(contentsOf: url)
    }

    static func megabytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private extension NSItemProvider {
    /// A link or file URL. (loadItem hands a link over as a property list; loadObject reads it.)
    func loadURL() async -> URL? {
        await withCheckedContinuation { continuation in
            _ = loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
        }
    }

    func loadText() async -> String? {
        if canLoadObject(ofClass: String.self) {
            let text: String? = await withCheckedContinuation { continuation in
                _ = loadObject(ofClass: String.self) { text, _ in continuation.resume(returning: text) }
            }
            if let text { return text }
        }
        guard let item = try? await loadItem(forTypeIdentifier: UTType.plainText.identifier) else { return nil }
        switch item {
        case let text as String: return text
        case let text as NSAttributedString: return text.string
        case let data as Data: return String(data: data, encoding: .utf8)
        case let url as URL where url.isFileURL: return try? String(contentsOf: url, encoding: .utf8)
        default: return nil
        }
    }

    func data(for type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = loadDataRepresentation(for: type) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    /// A shared file's bytes and name (read from the copy the system hands over).
    func file() async throws -> (Data, String?) {
        try await withCheckedThrowingContinuation { continuation in
            _ = loadFileRepresentation(for: .data) { url, _, error in
                guard let url else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                    return
                }
                do {
                    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    guard size <= ShareItem.maxBytes else {  // don't read a file into memory to refuse it
                        continuation.resume(throwing: ShareModel.ShareProblem(message: ShareSizing.tooBig(size)))
                        return
                    }
                    continuation.resume(returning: (try Data(contentsOf: url), url.lastPathComponent))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
