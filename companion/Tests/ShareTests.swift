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
        XCTAssertEqual(try ShareSizing.fit(image: small, decoded: nil).data, small)  // fits as it came
        let tooBig = Data(count: ShareItem.maxBytes + 1)
        XCTAssertThrowsError(try ShareSizing.fit(image: tooBig, decoded: nil))  // and can't be scaled
        let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 50)).image { _ in }
        let scaled = try XCTUnwrap(ShareSizing.scaled(image, longest: 20))
        XCTAssertEqual(scaled.size.width * scaled.scale, 20, accuracy: 1)
        XCTAssertEqual(scaled.size.height * scaled.scale, 10, accuracy: 1)
    }

    func testTheMacSaysWhatItDid() throws {
        let asked = try JSONDecoder().decode(ShareResult.self, from: Data(#"{"ok": true, "saved_as": "Board notes.pdf", "asked": true}"#.utf8))
        XCTAssertEqual(asked, ShareResult(savedAs: "Board notes.pdf", asked: true))
        let older = try JSONDecoder().decode(ShareResult.self, from: Data(#"{"ok": true}"#.utf8))
        XCTAssertEqual(older, ShareResult(savedAs: nil, asked: false))
    }
}
