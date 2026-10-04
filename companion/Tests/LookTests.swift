import SwiftUI
import XCTest
@testable import JarvisCompanion

/// Obsidian on the iPhone: the look is kept as the Mac's id, and its dial draws exactly the
/// Mac's (the expected numbers come from src/jarvis/web/obsidian.js, run with node).
final class LookTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: Look.key)
        Look.current = .starkGlass
        super.tearDown()
    }

    func testTheLookIsKeptAndStarkGlassIsTheDefault() {
        UserDefaults.standard.removeObject(forKey: Look.key)
        XCTAssertEqual(Look.stored, .starkGlass)
        UserDefaults.standard.set("obsidian", forKey: Look.key)
        XCTAssertEqual(Look.stored, .obsidian)
        UserDefaults.standard.set("nonsense", forKey: Look.key)
        XCTAssertEqual(Look.stored, .starkGlass, "an unknown value falls back to the default")
        XCTAssertEqual(Look.starkGlass.rawValue, "glass", "the Mac's id for Stark Glass")
    }

    func testThePaletteFollowsTheLook() {
        Look.current = .starkGlass
        XCTAssertEqual(Palette.champagne, Color(hex: 0xE8C27A))
        Look.current = .obsidian
        XCTAssertEqual(Palette.champagne, Obsidian.brassText)
        XCTAssertEqual(Palette.cyan, Obsidian.arc)
        XCTAssertEqual(Palette.space, Obsidian.bg)
    }

    func testTheDialIsTheMacs() {
        let cases: [(Int, DialGeometry.State, Double, Double, Double, Bool)] = [
            (0, .idle, 0, 0, 12.000000000, true),
            (5, .idle, 1.3, 0.4, 5.000000000, true),
            (37, .idle, 2.75, 1, 5.000000000, false),
            (100, .idle, 7.1, 0.2, 5.000000000, false),
            (143, .idle, 12.5, 0.8, 5.000000000, false),
            (0, .listening, 0, 0, 4.000000000, false),
            (5, .listening, 1.3, 0.4, 21.522491908, true),
            (37, .listening, 2.75, 1, 38.269627700, true),
            (100, .listening, 7.1, 0.2, 16.415132097, true),
            (143, .listening, 12.5, 0.8, 37.725880951, true),
            (0, .thinking, 0, 0, 5.000000000, false),
            (70, .thinking, 1.3, 0, 12.778174593, true),
            (5, .thinking, 1.3, 0.4, 4.000000000, false),
            (143, .thinking, 12.5, 0.8, 4.000000000, false),
            (0, .speaking, 0, 0, 4.000000000, false),
            (5, .speaking, 1.3, 0.4, 5.575723390, false),
            (37, .speaking, 2.75, 1, 4.061863294, false),
            (100, .speaking, 7.1, 0.2, 9.839667851, false),
            (143, .speaking, 12.5, 0.8, 7.316308754, false),
        ]
        for (i, state, t, level, length, bright) in cases {
            let got = DialGeometry.tickLength(i, state, t, level)
            XCTAssertEqual(got, length, accuracy: 1e-6, "tick \(i) \(state) at \(t)")
            XCTAssertEqual(DialGeometry.tickBright(i, state, got, t), bright, "tick \(i) \(state) at \(t)")
        }
        let rings: [(DialGeometry.State, Double, Double, Double)] = [
            (.idle, 0, 0, 0),
            (.listening, 0.3, 0, 6.283185307),
            (.thinking, 0.95, 3.336814693, 1.382300768),
            (.speaking, 0.55, 0, 6.283185307),
        ]
        for (state, opacity, start, sweep) in rings {
            let ring = DialGeometry.ring(state, 3.7)
            XCTAssertEqual(ring.opacity, opacity, accuracy: 1e-9)
            XCTAssertEqual(ring.start, start, accuracy: 1e-6)
            XCTAssertEqual(ring.sweep, sweep, accuracy: 1e-6)
        }
        XCTAssertEqual(DialGeometry.sweepHead(9.9), 43)
        XCTAssertEqual(DialGeometry.State(.offline), .idle)
    }
}
