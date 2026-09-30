import SwiftUI
import WidgetKit

/// The Watch face: what needs your OK, Jarvis Code, and what's next, from the snapshot the
/// Watch app keeps (from its own visits to the Mac, and what the iPhone passes on).
@main
struct JarvisComplications: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JarvisWatch", provider: SnapshotProvider()) { entry in
            ComplicationView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Jarvis")
        .description("What needs your OK, Jarvis Code, and what’s next.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

private struct ComplicationView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryRectangular: RectangularGlance(snapshot: entry.snapshot)
        case .accessoryInline: InlineGlance(snapshot: entry.snapshot)
        case .accessoryCorner: corner
        default: CircularGlance(snapshot: entry.snapshot)
        }
    }

    /// A glyph in the corner, and a word on the bezel.
    private var corner: some View {
        Image(systemName: symbol)
            .font(.title3.weight(.medium))
            .widgetAccentable()
            .widgetLabel(label)
            .accessibilityLabel(label)
    }

    private var symbol: String {
        guard let snapshot = entry.snapshot else { return "link" }
        if snapshot.pendingApprovals > 0 { return "hand.raised.fill" }
        if snapshot.isStale() { return "wifi.exclamationmark" }
        if snapshot.needsYouCount + snapshot.workingCount > 0 { return "chevron.left.forwardslash.chevron.right" }
        return "sparkle"
    }

    private var label: String {
        guard let snapshot = entry.snapshot else { return "Pair on iPhone" }
        if snapshot.pendingApprovals > 0 { return GlanceText.approvals(snapshot.pendingApprovals) }
        if snapshot.isStale() { return "Offline" }
        return GlanceText.code(snapshot) ?? "All quiet"
    }
}
