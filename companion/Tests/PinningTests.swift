import Security
import XCTest
@testable import JarvisCompanion

/// A throwaway self-signed ECDSA P-256 certificate (public data only; its key was never
/// kept), the shape the Mac's companion server uses, and its SHA-256.
enum TestCertificate {
    static let der = Data(base64Encoded: "MIIBgTCCASegAwIBAgIUJXsNNmzIEtsBw8ot2KspnmsG/A0wCgYIKoZIzj0EAwIwFjEUMBIGA1UEAwwLSmFydmlzIFRlc3QwHhcNMjYwOTMwMDMxNjE2WhcNMjYxMDMwMDMxNjE2WjAWMRQwEgYDVQQDDAtKYXJ2aXMgVGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJGdJ6g4guoAc0LFROnR1e0kLHzcoRl/dfqe5trCKjmQvcn7FORsxRMjuWFVYGJhH1utWohChxXJ29Iu/mNtuPSjUzBRMB0GA1UdDgQWBBRqy24D7u3N7IVqftMdIIRsI9F0lDAfBgNVHSMEGDAWgBRqy24D7u3N7IVqftMdIIRsI9F0lDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIDPO5ee2UyKWpVXA76EsKK7aMhB+7jRkAxf9C4exvJQYAiEAhw1kVSRR+xZSqicFMdHrsCVlm4QaVPdR59axtOSeURQ=")!
    static let fingerprint = "c6dc6d34c400e25777b6cd11a2c49764d0564cf3c74ff8a23bb70f9d9788989a"

    static var certificate: SecCertificate { SecCertificateCreateWithData(nil, der as CFData)! }

    static func trust(host: String = "mac.local") -> SecTrust {
        var trust: SecTrust?
        let policy = SecPolicyCreateSSL(true, host as CFString)
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, policy, &trust), errSecSuccess)
        return trust!
    }
}

final class CertificatePinTests: XCTestCase {
    func testFingerprintIsTheSHA256OfTheDERBytes() {
        XCTAssertEqual(CertificatePin.fingerprint(of: TestCertificate.der), TestCertificate.fingerprint)
        XCTAssertEqual(CertificatePin.fingerprint(of: TestCertificate.certificate), TestCertificate.fingerprint)
        XCTAssertEqual(CertificatePin.fingerprint(of: Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    func testNormalizeAcceptsTheUsualWritingsAndNothingElse() {
        let fp = TestCertificate.fingerprint
        XCTAssertEqual(CertificatePin.normalize(fp.uppercased()), fp)
        let colons = stride(from: 0, to: 64, by: 2).map { i -> String in
            let start = fp.index(fp.startIndex, offsetBy: i)
            return String(fp[start..<fp.index(start, offsetBy: 2)])
        }.joined(separator: ":")
        XCTAssertEqual(CertificatePin.normalize(colons), fp)
        XCTAssertEqual(CertificatePin.normalize(" \(fp) "), fp)
        XCTAssertNil(CertificatePin.normalize(String(fp.dropLast())))
        XCTAssertNil(CertificatePin.normalize(String(fp.dropLast()) + "g"))
        XCTAssertNil(CertificatePin.normalize(""))
    }

    func testShortFormIsFourGroupsOfFour() {
        XCTAssertEqual(CertificatePin.short(TestCertificate.fingerprint), "c6dc 6d34 c400 e257")
        XCTAssertTrue(CertificatePin.shortMatches("c6dc 6d34 c400 e257", TestCertificate.fingerprint))
        XCTAssertTrue(CertificatePin.shortMatches("C6DC6D34", TestCertificate.fingerprint))
        XCTAssertFalse(CertificatePin.shortMatches("c6dc 6d34 c400 e258", TestCertificate.fingerprint))
        XCTAssertFalse(CertificatePin.shortMatches("c6", TestCertificate.fingerprint))  // too short to mean anything
    }

    func testOnlyTheExactPinnedCertificateIsAccepted() {
        let fp = TestCertificate.fingerprint
        XCTAssertTrue(CertificatePin.accepts(presented: fp, pinned: fp.uppercased()))
        XCTAssertFalse(CertificatePin.accepts(presented: fp, pinned: nil))
        XCTAssertFalse(CertificatePin.accepts(presented: nil, pinned: fp))
        XCTAssertFalse(CertificatePin.accepts(presented: fp, pinned: String(repeating: "0", count: 64)))
        XCTAssertFalse(CertificatePin.accepts(presented: String(fp.prefix(16)), pinned: String(fp.prefix(16))))
    }

    func testTheTrustDecisionUsesTheCredentialOnlyForThePin() {
        let trust = TestCertificate.trust()
        let (yes, presented) = ServerTrustDelegate.decide(trust: trust, mode: .pin(TestCertificate.fingerprint))
        XCTAssertEqual(yes, .useCredential)
        XCTAssertEqual(presented, TestCertificate.fingerprint)

        let (no, other) = ServerTrustDelegate.decide(trust: trust, mode: .pin(String(repeating: "a", count: 64)))
        XCTAssertEqual(no, .cancelAuthenticationChallenge)
        XCTAssertEqual(other, TestCertificate.fingerprint)

        // Trust on first use reads the certificate and still refuses the connection.
        let (capture, seen) = ServerTrustDelegate.decide(trust: trust, mode: .capture)
        XCTAssertEqual(capture, .cancelAuthenticationChallenge)
        XCTAssertEqual(seen, TestCertificate.fingerprint)
    }

    func testTheHostNameDoesNotMatterOnlyThePin() {
        // The certificate names no host: an IP, a .local name or a Tailscale address all work.
        for host in ["192.168.1.20", "mac.local", "100.101.102.103"] {
            XCTAssertEqual(ServerTrustDelegate.decide(trust: TestCertificate.trust(host: host), mode: .pin(TestCertificate.fingerprint)).0, .useCredential)
        }
    }

    func testARefusedCertificateReadsAsAMismatchNotACancel() {
        let delegate = ServerTrustDelegate(.pin(String(repeating: "b", count: 64)))
        XCTAssertTrue(JarvisAPI.map(URLError(.cancelled), delegate: delegate) is CancellationError)  // nothing refused yet
        XCTAssertEqual(delegate.evaluate(TestCertificate.trust()), .cancelAuthenticationChallenge)
        XCTAssertTrue(delegate.rejected)
        XCTAssertEqual(delegate.presented, TestCertificate.fingerprint)
        XCTAssertEqual(JarvisAPI.map(URLError(.cancelled), delegate: delegate) as? JarvisError, .certificateMismatch)

        let pinned = ServerTrustDelegate(.pin(TestCertificate.fingerprint))
        XCTAssertEqual(pinned.evaluate(TestCertificate.trust()), .useCredential)
        XCTAssertFalse(pinned.rejected)
        XCTAssertEqual(JarvisAPI.map(URLError(.secureConnectionFailed), delegate: nil) as? JarvisError, .notEncrypted)
        XCTAssertEqual(JarvisAPI.map(URLError(.timedOut), delegate: nil) as? JarvisError, .timedOut)
        XCTAssertEqual(JarvisAPI.map(URLError(.networkConnectionLost), delegate: nil) as? JarvisError, .connectionLost)
        let unreachable = JarvisAPI.map(URLError(.cannotConnectToHost), delegate: nil) as? JarvisError
        XCTAssertEqual(unreachable?.neverDelivered, true)
        XCTAssertEqual(JarvisError.connectionLost.neverDelivered, false)
        XCTAssertEqual(JarvisError.timedOut.neverDelivered, false)
    }

    func testNothingIsSentWithoutAPin() async {
        let api = JarvisAPI(baseURL: URL(string: "https://mac.local:8765")!, token: "t", fingerprint: nil)
        do {
            _ = try await api.state()
            XCTFail("sent without a pin")
        } catch {
            XCTAssertEqual(error as? JarvisError, .notPinned)
        }
        let plain = JarvisAPI(baseURL: URL(string: "http://mac.local:8765")!, token: "t", fingerprint: TestCertificate.fingerprint)
        do {
            _ = try await plain.state()
            XCTFail("sent in the clear")
        } catch {
            XCTAssertEqual(error as? JarvisError, .notPinned)
        }
    }
}

final class PairingLinkTests: XCTestCase {
    private let fp = TestCertificate.fingerprint

    func testReadsTheMacsQRCode() throws {
        let link = try XCTUnwrap(PairingLink("jarvis-pair://Tonys-MacBook.local:8765?code=042917&fp=\(fp)&name=Tony%E2%80%99s%20MacBook%20Pro"))
        XCTAssertEqual(link.baseURL.absoluteString, "https://Tonys-MacBook.local:8765")
        XCTAssertEqual(link.code, "042917")
        XCTAssertEqual(link.fingerprint, fp)
        XCTAssertEqual(link.macName, "Tony’s MacBook Pro")
        XCTAssertEqual(link.label, "Tony’s MacBook Pro")
    }

    func testDefaultsThePortAndTakesOtherWritings() throws {
        let link = try XCTUnwrap(PairingLink("JARVIS-PAIR://192.168.1.20?fp=\(fp.uppercased())&code=123456&name=Stark+Mac"))
        XCTAssertEqual(link.baseURL.absoluteString, "https://192.168.1.20:8765")
        XCTAssertEqual(link.fingerprint, fp)
        XCTAssertEqual(link.macName, "Stark Mac")
        let v6 = try XCTUnwrap(PairingLink("jarvis-pair://[fd7a:115c::1]:8766?code=123456&fp=\(fp)"))
        XCTAssertEqual(v6.baseURL.absoluteString, "https://[fd7a:115c::1]:8766")
        XCTAssertNil(v6.macName)
        XCTAssertEqual(v6.label, "[fd7a:115c::1]:8766")
    }

    func testRefusesAnythingIncomplete() {
        XCTAssertNil(PairingLink("https://mac.local:8765?code=123456&fp=\(fp)"))
        XCTAssertNil(PairingLink("jarvis-pair://mac.local:8765?code=123456"))
        XCTAssertNil(PairingLink("jarvis-pair://mac.local:8765?code=12345&fp=\(fp)"))
        XCTAssertNil(PairingLink("jarvis-pair://mac.local:8765?code=12345a&fp=\(fp)"))
        XCTAssertNil(PairingLink("jarvis-pair://mac.local:8765?code=١٢٣٤٥٦&fp=\(fp)"))  // Arabic-Indic digits
        XCTAssertNil(PairingLink("jarvis-pair://mac.local:8765?code=123456&fp=abc"))
        XCTAssertNil(PairingLink("jarvis-pair://?code=123456&fp=\(fp)"))
        XCTAssertNil(PairingLink("some text"))
    }
}

final class PairingTests: XCTestCase {
    func testOnlyAnHTTPSPairingWithAFingerprintIsUsable() {
        let url = URL(string: "https://mac.local:8765")!
        var pairing = Pairing(baseURL: url, token: "t", macName: "Mac", deviceName: "iPhone", pairedAt: Date(), fingerprint: TestCertificate.fingerprint)
        XCTAssertTrue(pairing.isPinned)
        XCTAssertEqual(pairing.shortFingerprint, "c6dc 6d34 c400 e257")
        XCTAssertEqual(pairing.api.fingerprint, TestCertificate.fingerprint)
        pairing.fingerprint = nil
        XCTAssertFalse(pairing.isPinned)
        pairing.fingerprint = TestCertificate.fingerprint
        pairing.baseURL = URL(string: "http://mac.local:8765")!
        XCTAssertFalse(pairing.isPinned)
    }

    func testAPairingFromBeforeTLSStillDecodes() throws {
        let old = #"{"baseURL":"http:\/\/192.168.1.20:8765","token":"abc","macName":"Mac","deviceName":"iPhone","pairedAt":780000000}"#
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data(old.utf8))
        XCTAssertNil(pairing.fingerprint)
        XCTAssertFalse(pairing.isPinned)
    }

    func testTheWatchGetsThePinAndIgnoresAPairingWithout() {
        let pairing = Pairing(
            baseURL: URL(string: "https://mac.local:8765")!, token: "t", macName: "Mac", deviceName: "iPhone",
            pairedAt: Date(), fingerprint: TestCertificate.fingerprint
        )
        guard case .paired(let received) = WatchLink.update(from: WatchLink.context(for: pairing)) else {
            return XCTFail("no pairing")
        }
        XCTAssertEqual(received.fingerprint, TestCertificate.fingerprint)
        XCTAssertEqual(received.token, "t")
        XCTAssertEqual(received.deviceName, "Apple Watch")

        var legacy = WatchLink.context(for: pairing)
        legacy["fingerprint"] = ""
        XCTAssertEqual(WatchLink.update(from: legacy), .nothing)
        XCTAssertEqual(WatchLink.update(from: WatchLink.context(for: nil)), .unpaired)
    }
}
