import LocalAuthentication

/// Face ID (or the passcode) before something that runs things on the Mac from the iPhone:
/// a "!" command, Bypass permissions, an "always allow".
enum OwnerCheck {
    static func confirm(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return true  // no passcode on this iPhone: nothing to check against
        }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}
