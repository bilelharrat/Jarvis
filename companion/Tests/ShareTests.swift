import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import JarvisCompanion

/// The share sheet: what it reads from what was shared, and what it sends.
final class ShareTests: XCTestCase {
    func testReadsALink() async throws {
        let provider = NSItemProvider(object: URL(string: "https://example.com/article?id=7")! as NSURL)
        let read = try await ShareModel.read([provider])
        let loaded = try XCTUnwrap(read)
        XCTAssertEqual(loaded.item.kind, .url)
        XCTAssertEqual(loaded.item.url, "https://example.com/article?id=7")
        XCTAssertNil(loaded.item.data)
    }

    func testReadsText() async throws {
        let provider = NSItemProvider(object: "Remember the milk and the eggs." as NSString)
        let read = try await ShareModel.read([provider])
        let loaded = try XCTUnwrap(read)
        XCTAssertEqual(loaded.item.kind, .text)
        XCTAssertEqual(loaded.item.text, "Remember the milk and the eggs.")
        XCTAssertEqual(loaded.title, "Remember the milk and the eggs.")
    }

    func testReadsAFileWithItsName() async throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "Board notes \(UUID().uuidString.prefix(4)).pdf")
        try Data("%PDF-1.7 test".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let provider = try XCTUnwrap(NSItemProvider(contentsOf: url))
        let read = try await ShareModel.read([provider])
        let loaded = try XCTUnwrap(read)
        XCTAssertEqual(loaded.item.kind, .file)
        XCTAssertEqual(loaded.item.data, Data("%PDF-1.7 test".utf8))
        XCTAssertEqual(loaded.item.name, url.lastPathComponent)  // its own name, not the copy's
    }

    func testReadsAnImage() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 20)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
        }
        let provider = NSItemProvider(object: image)
        let read = try await ShareModel.read([provider])
        let loaded = try XCTUnwrap(read)
        XCTAssertEqual(loaded.item.kind, .image)
        XCTAssertFalse(loaded.item.data?.isEmpty ?? true)
        XCTAssertNotNil(loaded.preview)
    }

    func testNothingItCanSend() async throws {
        let loaded = try await ShareModel.read([])
        XCTAssertNil(loaded)
    }

    func testAPhotoWithoutANameGetsItsType() {
        XCTAssertEqual(ShareSizing.imageExtension(of: Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), "jpg")
        XCTAssertEqual(ShareSizing.imageExtension(of: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])), "png")
        XCTAssertEqual(ShareSizing.imageExtension(of: Data([0, 0, 0, 0x18]) + Data("ftypheic".utf8)), "heic")
        XCTAssertNil(ShareSizing.imageExtension(of: Data("hello".utf8)))
        XCTAssertEqual(ShareSizing.name(nil, fallback: "Photo", ext: "jpg"), "Photo.jpg")
    }

    func testTheFileKeepsTheNameItHad() {
        XCTAssertEqual(ShareSizing.fileName(suggested: "Board notes", loaded: "PDF document.pdf"), "Board notes.pdf")
        XCTAssertEqual(ShareSizing.fileName(suggested: "Board notes.pdf", loaded: "PDF document.pdf"), "Board notes.pdf")
        XCTAssertEqual(ShareSizing.fileName(suggested: nil, loaded: "PDF document.pdf"), "PDF document.pdf")
        XCTAssertEqual(ShareSizing.fileName(suggested: "  ", loaded: nil), nil)
    }

    func testNamesAreSafeForTheMac() {
        XCTAssertEqual(ShareSizing.name("Report Q3.pdf", fallback: "File", ext: nil), "Report Q3.pdf")
        XCTAssertEqual(ShareSizing.name("../etc/passwd", fallback: "File", ext: nil), "File")  // no way out of the Inbox
        XCTAssertEqual(ShareSizing.name("a/b:c.txt", fallback: "File", ext: nil), "a-b-c.txt")
        XCTAssertEqual(ShareSizing.name(nil, fallback: "Photo", ext: "jpg"), "Photo.jpg")
        XCTAssertEqual(ShareSizing.name(".hidden", fallback: "File", ext: nil), "File")
        XCTAssertEqual(ShareSizing.name("IMG_0001.HEIC", fallback: "Photo", ext: "jpg"), "IMG_0001.jpg")
        XCTAssertEqual(ShareSizing.name(String(repeating: "x", count: 300), fallback: "File", ext: nil).count, 120)
    }

    func testImagesFitWhatTheMacTakes() throws {
        let small = Data(repeating: 1, count: 1000)
        XCTAssertEqual(try ShareSizing.fit(image: small).data, small)  // fits as it came
        let tooBig = Data(count: ShareItem.maxBytes + 1)
        XCTAssertThrowsError(try ShareSizing.fit(image: tooBig))  // and can't be scaled
        let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 50)).image { _ in }
        let scaled = try XCTUnwrap(ShareSizing.scaled(image, longest: 20))
        XCTAssertEqual(scaled.size.width * scaled.scale, 20, accuracy: 1)
        XCTAssertEqual(scaled.size.height * scaled.scale, 10, accuracy: 1)
    }

    /// The Mac takes JPEG, PNG, GIF, HEIC and WebP pictures and refuses the rest as "not a
    /// picture": a TIFF, a RAW photo or a BMP goes as a JPEG instead.
    func testAPictureTheMacCantReadGoesAsJPEG() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        for type in [UTType.tiff, .bmp] {
            let data = try XCTUnwrap(Self.encode(image, as: type), "\(type)")
            let fitted = try ShareSizing.fit(image: data)
            XCTAssertEqual(Array(fitted.data.prefix(3)), [0xFF, 0xD8, 0xFF], "\(type)")
            XCTAssertEqual(fitted.ext, "jpg", "\(type)")
        }
        let png = try XCTUnwrap(image.pngData())
        XCTAssertEqual(try ShareSizing.fit(image: png).data, png)  // as it came
    }

    /// The preview is a thumbnail. A share extension has little memory, and a photo decoded
    /// whole (24 megapixels: about 100 MB) could get it closed mid-share.
    func testThePreviewIsAThumbnailNotTheWholePhoto() async throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let jpeg = try XCTUnwrap(big.jpegData(compressionQuality: 0.5))
        let provider = NSItemProvider(item: jpeg as NSData, typeIdentifier: UTType.jpeg.identifier)
        let read = try await ShareModel.read([provider])
        let loaded = try XCTUnwrap(read)
        XCTAssertEqual(loaded.item.data, jpeg)  // the photo itself goes whole
        let preview = try XCTUnwrap(loaded.preview)
        XCTAssertLessThanOrEqual(max(preview.size.width, preview.size.height) * preview.scale, 400)
    }

    /// The Mac takes a shared file of up to 25 MB (companion_api.SHARE_BYTES) in a body of at
    /// most SHARE_BODY; the note is kept to the 2,000 characters the Mac reads.
    func testFilesUpToTheMacs25MBGo() throws {
        XCTAssertEqual(ShareItem.maxBytes, 25 * 1024 * 1024)
        let pattern = Data((0..<3001).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
        var data = Data(capacity: ShareItem.maxBytes + pattern.count)
        while data.count < ShareItem.maxBytes { data.append(pattern) }
        data = data.prefix(ShareItem.maxBytes)
        let item = ShareItem(kind: .file, name: "Board deck.key", data: data, note: String(repeating: "é", count: 5000))
        let body = try item.body()
        XCTAssertLessThanOrEqual(body.count, 25 * 1024 * 1024 * 4 / 3 + 64 * 1024)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "file")
        XCTAssertEqual((json["note"] as? String)?.count, 2000)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(json["data_base64"] as? String)), data)
    }

    private static func encode(_ image: UIImage, as type: UTType) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cgImage, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    func testTheMacSaysWhatItDid() throws {
        let asked = try JSONDecoder().decode(ShareResult.self, from: Data(#"{"ok": true, "saved_as": "Board notes.pdf", "asked": true}"#.utf8))
        XCTAssertEqual(asked, ShareResult(savedAs: "Board notes.pdf", asked: true))
        let older = try JSONDecoder().decode(ShareResult.self, from: Data(#"{"ok": true}"#.utf8))
        XCTAssertEqual(older, ShareResult(savedAs: nil, asked: false))
    }
}
