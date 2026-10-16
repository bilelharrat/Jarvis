#if DEBUG
import Foundation

/// Debug-build-only launch arguments (the companion's DebugLaunch pattern), e.g.
///
///     xcrun simctl launch <device> com.askeden.jarvis.edencode -EDENCODEFixtures YES -EDENCODEOpen session:5
///
/// -EDENCODEFixtures YES: the demo's sample sessions (DemoBackend) instead of a Mac, for screenshots.
/// -EDENCODEOpen session:<id> | changes:<id> | approve | drawer | inbox | queue | settings | new | pair
/// -EDENCODEServer host:port -EDENCODECode 123456: pairs with a test Mac at launch.
/// -EDENCODEReset YES: forgets every paired Mac.
/// None of this exists in Release builds.
enum EdenDebug {
    private static var defaults: UserDefaults { .standard }
    static var fixtures: Bool { defaults.bool(forKey: "EDENCODEFixtures") }
    static var open: String? { defaults.string(forKey: "EDENCODEOpen") }
    static var server: String? { defaults.string(forKey: "EDENCODEServer") }
    static var code: String? { defaults.string(forKey: "EDENCODECode") }
    static var reset: Bool { defaults.bool(forKey: "EDENCODEReset") }
    static var typed: String? { defaults.string(forKey: "EDENCODETyped") }
    static var composerOpen: Bool { defaults.bool(forKey: "EDENCODEComposerOpen") }
    static var focus: Bool { defaults.bool(forKey: "EDENCODEFocus") }
    /// -EDENCODEModels YES: the model list open over the input bar (for screenshots).
    static var models: Bool { defaults.bool(forKey: "EDENCODEModels") }
}
#endif
