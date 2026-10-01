#if DEBUG
import Foundation

/// Debug-build-only launch arguments for trying the app against a test server in the
/// Simulator without typing, e.g.
///
///     xcrun simctl launch booted com.bshventures.jarvis.companion \
///       -JARVISResetPairing YES -JARVISTestServer 127.0.0.1:8766 -JARVISTestCode 123456 \
///       -JARVISTestAsk "What's next today?"
///
/// None of this exists in Release builds.
enum DebugLaunch {
    private static var defaults: UserDefaults { .standard }

    /// Pre-fills the Mac address on the pairing screen (the Watch pairs with it directly).
    static var server: String? { defaults.string(forKey: "JARVISTestServer") }
    /// Pre-fills the pairing code and pairs a moment later.
    static var code: String? { defaults.string(forKey: "JARVISTestCode") }
    /// Forget any pairing at launch.
    static var resetPairing: Bool { defaults.bool(forKey: "JARVISResetPairing") }
    /// Sends this as a typed request once connected.
    static var ask: String? { defaults.string(forKey: "JARVISTestAsk") }
    /// Answers the first approval card with this choice id a few seconds after it shows.
    static var approve: String? { defaults.string(forKey: "JARVISTestApprove") }
    /// The Watch answers the first approval card with No, because… and this reason.
    static var reason: String? { defaults.string(forKey: "JARVISTestReason") }
    /// "NO" turns spoken replies off for this launch.
    static var speak: Bool? { defaults.object(forKey: "JARVISTestSpeak") == nil ? nil : defaults.bool(forKey: "JARVISTestSpeak") }

    /// Shows the app without pairing or a key (to look at the screens).
    static var skipSetup: Bool { defaults.bool(forKey: "JARVISSkipSetup") }

    /// The pairing prefill runs once per launch, not every time the pairing screen shows.
    @MainActor static var prefilled = false
}
#endif
