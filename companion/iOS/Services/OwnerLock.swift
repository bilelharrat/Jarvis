import UIKit

/// "Only answer when unlocked". iOS gives apps no way to recognise a voice, so Face ID (or
/// the passcode) is how Jarvis knows the one asking is the owner: with this on, Siri, Vocal
/// Shortcuts and "Hey Jarvis" in the background answer only once the iPhone has been
/// unlocked. Stop always works.
@MainActor
enum OwnerLock {
    static let key = "brain.ownerOnly"
    nonisolated static let refusal = "Unlock your iPhone first, then ask me again. I only answer you."

    static var isOn: Bool { UserDefaults.standard.bool(forKey: key) }

    /// Whether Jarvis may answer now: the lock is off, or the iPhone is unlocked.
    static var allows: Bool { allows(on: isOn, unlocked: UIApplication.shared.isProtectedDataAvailable) }

    nonisolated static func allows(on: Bool, unlocked: Bool) -> Bool { !on || unlocked }
}
