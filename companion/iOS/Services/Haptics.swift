import UIKit

/// The companion's haptic vocabulary.
@MainActor
enum Haptics {
    static func talkStart() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func talkStop() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func tap() { UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.8) }
    static func reply() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    /// Jarvis needs a yes.
    static func attention() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func answered(negative: Bool) {
        if negative {
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        } else {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }
    static func failure() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}
