import XCTest
@testable import JarvisCompanion

/// More than one Jarvis on this iPhone (a Mac, the cloud one): which is the same Jarvis, and
/// which addresses are on the local network.
final class SwitcherTests: XCTestCase {
    private func pairing(_ url: String, fp: String?) -> Pairing {
        Pairing(baseURL: URL(string: url)!, token: "t", macName: nil, deviceName: nil, pairedAt: Date(), fingerprint: fp)
    }

    func testTheSameJarvisIsKnownByItsCertificateThenItsAddress() {
        let fp = String(repeating: "ab", count: 32)
        XCTAssertTrue(PairingStore.same(pairing("https://192.168.1.20:8765", fp: fp), pairing("https://mac.local:8765", fp: fp)))
        XCTAssertFalse(PairingStore.same(pairing("https://192.168.1.20:8765", fp: fp),
                                         pairing("https://136.70.26.67:8765", fp: String(repeating: "cd", count: 32))))
        XCTAssertTrue(PairingStore.same(pairing("https://10.0.0.2:8765", fp: nil), pairing("https://10.0.0.2:8765", fp: nil)))
    }

    func testLocalAddressesAndTheInternet() {
        for local in ["https://mac.local:8765", "https://192.168.1.20:8765", "https://10.1.2.3:8765", "https://172.20.0.5:8765", "https://100.101.2.3:8765"] {
            XCTAssertTrue(MacAddress.isLocal(URL(string: local)!), local)
        }
        for internet in ["https://136.70.26.67:8765", "https://172.40.0.5:8765", "https://jarvis.example.com:8765"] {
            XCTAssertFalse(MacAddress.isLocal(URL(string: internet)!), internet)
        }
    }

    func testACloudJarvisShowsACloud() {
        var cloud = pairing("https://136.70.26.67:8765", fp: nil)
        XCTAssertEqual(JarvisSwitcher.symbol(for: cloud), "cloud.fill")
        cloud.macName = "MacBook Air"
        cloud.baseURL = URL(string: "https://192.168.1.5:8765")!
        XCTAssertEqual(JarvisSwitcher.symbol(for: cloud), "desktopcomputer")
        cloud.macName = "Jarvis Cloud"
        XCTAssertEqual(JarvisSwitcher.symbol(for: cloud), "cloud.fill")
    }
}
