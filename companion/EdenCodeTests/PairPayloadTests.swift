import XCTest
@testable import EdenCode

/// Pairing by QR (docs/eden-code-phone.md "Pairing by QR"; the Mac's side is
/// src/jarvis/features/code_phone_pair.py and tests/test_code_phone_pair.py): the payload
/// parser, the addresses tried in turn, and edencode://pair from the Camera app.
final class PairPayloadTests: XCTestCase {
    private let fp = String(repeating: "ab", count: 32)

    private func parse(_ text: String) -> PairPayload? {
        if case .success(let payload) = PairPayload.parse(text) { return payload }
        return nil
    }

    private func problem(_ text: String) -> PairPayload.Problem? {
        if case .failure(let why) = PairPayload.parse(text) { return why }
        return nil
    }

    func testReadsTheMacsPayloadExactlyAsItsBuilderWritesIt() throws {
        // (the string test_the_payload_has_the_fixed_format_in_order asserts on the Mac)
        let text = "edencode://pair?v=1&code=042917&host=Studio.local&ip=192.168.1.20&port=8765"
            + "&fp=\(fp)&name=Bilel%27s%20Mac%20Studio&ts=studio.tail1234.ts.net&relay=1"
        let payload = try XCTUnwrap(parse(text))
        XCTAssertEqual(payload.code, "042917")
        XCTAssertEqual(payload.host, "Studio.local")
        XCTAssertEqual(payload.ip, "192.168.1.20")
        XCTAssertEqual(payload.port, 8765)
        XCTAssertEqual(payload.fingerprint, fp)
        XCTAssertEqual(payload.macName, "Bilel's Mac Studio")
        XCTAssertEqual(payload.tailscale, "studio.tail1234.ts.net")
        XCTAssertTrue(payload.relay)
        XCTAssertEqual(payload.label, "Bilel's Mac Studio")
        XCTAssertEqual(payload.candidates.map(\.absoluteString),
                       ["https://Studio.local:8765", "https://192.168.1.20:8765", "https://studio.tail1234.ts.net:8765"])
    }

    func testOptionalPartsAnyOrderAndUnknownParameters() throws {
        let payload = try XCTUnwrap(parse("EDENCODE://pair?fp=\(fp.uppercased())&code=000001&v=1&host=mac.local&port=9000&later=x"))
        XCTAssertEqual(payload.fingerprint, fp)  // (normalized)
        XCTAssertNil(payload.ip)
        XCTAssertNil(payload.tailscale)
        XCTAssertNil(payload.macName)
        XCTAssertFalse(payload.relay)
        XCTAssertEqual(payload.label, "mac.local")
        XCTAssertEqual(payload.candidates.map(\.absoluteString), ["https://mac.local:9000"])
        // A form encoder's "+" is a space; the host given twice is tried once.
        let plus = try XCTUnwrap(parse("edencode://pair?v=1&code=123456&host=10.0.0.7&ip=10.0.0.7&fp=\(fp)&name=Mac+Mini"))
        XCTAssertEqual(plus.macName, "Mac Mini")
        XCTAssertEqual(plus.port, 8765)
        XCTAssertEqual(plus.candidates.count, 1)
    }

    func testRefusesWhatTheFormatDoesntAllow() {
        let good = "v=1&code=123456&host=mac.local&port=8765&fp=\(fp)"
        XCTAssertNotNil(parse("edencode://pair?\(good)"))
        XCTAssertEqual(problem("https://example.com/pair?\(good)"), .notEdenCode)
        XCTAssertEqual(problem("edencode://session/5"), .notEdenCode)
        XCTAssertEqual(problem("hello"), .notEdenCode)
        XCTAssertEqual(problem("edencode://pair?v=2&code=123456&host=mac.local&fp=\(fp)"), .newerVersion)
        for bad in [
            "code=123456&host=mac.local&fp=\(fp)",  // no version
            "v=1&code=12345&host=mac.local&fp=\(fp)",
            "v=1&code=1234567&host=mac.local&fp=\(fp)",
            "v=1&code=12a456&host=mac.local&fp=\(fp)",
            "v=1&code=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&host=mac.local&fp=\(fp)",  // full-width
            "v=1&code=123456&fp=\(fp)",  // no host
            "v=1&code=123456&host=evil%20host&fp=\(fp)",
            "v=1&code=123456&host=a%2Fb&fp=\(fp)",
            "v=1&code=123456&host=user%40mac.local&fp=\(fp)",
            "v=1&code=123456&host=mac.local&fp=abc",
            "v=1&code=123456&host=mac.local",
            "v=1&code=123456&host=mac.local&port=0&fp=\(fp)",
            "v=1&code=123456&host=mac.local&port=70000&fp=\(fp)",
        ] {
            XCTAssertEqual(problem("edencode://pair?\(bad)"), .incomplete, bad)
        }
        // A bad optional address is dropped, not trusted.
        let odd = parse("edencode://pair?\(good)&ip=999.1.1.1&ts=a%20b")
        XCTAssertNil(odd?.ip)
        XCTAssertNil(odd?.tailscale)
    }

    func testTheCompanionsOwnQRCodePairsToo() throws {
        let payload = try XCTUnwrap(parse("jarvis-pair://studio.local:8766?code=654321&fp=\(fp)&name=Studio"))
        XCTAssertEqual(payload.code, "654321")
        XCTAssertEqual(payload.candidates.map(\.absoluteString), ["https://studio.local:8766"])
        XCTAssertEqual(payload.macName, "Studio")
        XCTAssertEqual(problem("jarvis-pair://studio.local?code=1&fp=\(fp)"), .incomplete)
    }

    func testEveryProblemHasWordsForTheOwner() {
        for problem in [PairPayload.Problem.notEdenCode, .newerVersion, .incomplete] {
            XCTAssertFalse(PairPayload.message(problem).isEmpty)
        }
    }

    // MARK: - Pairing: each address in turn, the code offered once

    private func payload() -> PairPayload {
        PairPayload(code: "123456", host: "mac.local", ip: "10.0.0.7", port: 8765, fingerprint: fp,
                    macName: "Studio", tailscale: "studio.ts.net")
    }

    private func pairing(_ base: URL) -> Pairing {
        Pairing(baseURL: base, token: "t", macName: "Studio", deviceName: "iPhone", pairedAt: Date(), fingerprint: fp)
    }

    func testPairingTriesTheNextAddressOnlyWhileTheMacIsntThere() async throws {
        var tried: [String] = []
        let result = try await MacStore.pair(payload(), deviceName: "iPhone") { base, pinned, code, _ in
            tried.append(base.absoluteString)
            XCTAssertEqual(pinned, self.fp)  // always the code's fingerprint
            XCTAssertEqual(code, "123456")
            if base.host() == "mac.local" { throw JarvisError.unreachable("no mDNS") }
            return self.pairing(base)
        }
        XCTAssertEqual(tried, ["https://mac.local:8765", "https://10.0.0.7:8765"])
        XCTAssertEqual(result.baseURL.absoluteString, "https://10.0.0.7:8765")
    }

    func testAMacThatAnswersEndsItSoTheCodeIsOfferedOnce() async {
        var tried = 0
        do {
            _ = try await MacStore.pair(payload(), deviceName: "iPhone") { _, _, _, _ in
                tried += 1
                throw JarvisError.wrongCode("That code isn't right, or it expired.")
            }
            XCTFail("paired with a wrong code")
        } catch {
            XCTAssertEqual(tried, 1)
            XCTAssertTrue(PairingView.scanProblem(error).contains("New code"))
        }
        // Another certificate at every address: each skipped, the code never accepted.
        var mismatched = 0
        do {
            _ = try await MacStore.pair(payload(), deviceName: "iPhone") { _, _, _, _ in
                mismatched += 1
                throw JarvisError.certificateMismatch
            }
            XCTFail("paired past a certificate that isn't the Mac's")
        } catch {
            XCTAssertEqual(mismatched, 3)
            XCTAssertTrue(PairingView.scanProblem(error).contains("wasn’t sent"))
        }
    }

    // MARK: - edencode://pair from the Camera app

    @MainActor
    func testTheURLSchemeHandsTheCodeToThePairingScreen() throws {
        let store = EdenCodeStore()
        let url = try XCTUnwrap(URL(string: "edencode://pair?v=1&code=123456&host=mac.local&port=8765&fp=\(fp)&name=Studio"))
        store.open(url: url)
        XCTAssertEqual(store.pendingPair?.code, "123456")
        XCTAssertEqual(store.pendingPair?.macName, "Studio")
        XCTAssertNil(store.pendingPairProblem)
        XCTAssertEqual(store.showPairing, store.paired)  // (no Mac yet: the pairing screen is already up)

        store.open(url: try XCTUnwrap(URL(string: "edencode://pair?v=9&code=123456&host=mac.local&fp=\(fp)")))
        XCTAssertNil(store.pendingPair)
        XCTAssertEqual(store.pendingPairProblem, PairPayload.message(.newerVersion))
    }

    @MainActor
    func testOtherEdenCodeLinksStillGoWhereTheyDid() throws {
        let store = EdenCodeStore()
        store.startDemo()
        store.open(url: try XCTUnwrap(URL(string: "edencode://pair?v=1&code=123456&host=mac.local&fp=\(fp)")))
        XCTAssertTrue(store.showPairing)  // (a Mac is paired: the sheet opens)
        store.showPairing = false
        store.pendingPair = nil
        store.open(url: try XCTUnwrap(URL(string: "edencode://inbox")))
        XCTAssertNil(store.pendingPair)
        XCTAssertFalse(store.showPairing)
    }
}
