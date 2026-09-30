import SwiftUI
import WidgetKit

/// One moment of a widget: the snapshot the app last wrote (nil: not paired yet).
struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

/// Reads the snapshot the app keeps in the App Group container. The widgets never talk to
/// the Mac: the app reloads them when what they show changes.
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: Date(), snapshot: context.isPreview ? .preview : SnapshotStore.shared.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date()
        let snapshot = SnapshotStore.shared.read()
        let entries = SnapshotTimeline.dates(for: snapshot, now: now).map { SnapshotEntry(date: $0, snapshot: snapshot) }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
    }
}

/// The widgets' calm night: the app's canvas and the reactor's glow.
struct WidgetBackground: View {
    var body: some View {
        ZStack {
            Palette.space
            RadialGradient(
                colors: [Palette.deep.opacity(0.35), Palette.deep.opacity(0.08), .clear],
                center: UnitPoint(x: 0.15, y: 0.1), startRadius: 0, endRadius: 220
            )
        }
    }
}

/// What the Lock Screen and Watch complications say, from a snapshot.
enum GlanceText {
    static func approvals(_ count: Int) -> String {
        count == 1 ? "1 needs your OK" : "\(count) need your OK"
    }

    static func code(_ snapshot: WidgetSnapshot) -> String? {
        if snapshot.needsYouCount > 0 {
            return snapshot.needsYouCount == 1 ? "Jarvis Code needs you" : "Jarvis Code: \(snapshot.needsYouCount) need you"
        }
        if snapshot.workingCount > 0 {
            return snapshot.workingCount == 1 ? "Jarvis Code is working" : "Jarvis Code: \(snapshot.workingCount) working"
        }
        return nil
    }
}

/// The Lock Screen's round slot (and the Watch's): what needs you, else the Mac's state.
struct CircularGlance: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let snapshot {
                if snapshot.pendingApprovals > 0 {
                    VStack(spacing: 0) {
                        Image(systemName: "hand.raised.fill")
                            .font(.caption.weight(.semibold))
                        Text("\(snapshot.pendingApprovals)")
                            .font(.title3.weight(.semibold).monospacedDigit())
                    }
                } else if snapshot.isStale() {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.title3.weight(.medium))
                } else if snapshot.needsYouCount + snapshot.workingCount > 0 {
                    Image(systemName: snapshot.needsYouCount > 0 ? "hand.raised.fill" : "chevron.left.forwardslash.chevron.right")
                        .font(.title3.weight(.medium))
                } else {
                    Image(systemName: "sparkle")
                        .font(.title2.weight(.medium))
                }
            } else {
                Image(systemName: "link")
                    .font(.title3)
            }
        }
        .widgetAccentable()
        .accessibilityLabel(accessibility)
    }

    private var accessibility: String {
        guard let snapshot else { return "Jarvis: not paired" }
        if snapshot.pendingApprovals > 0 { return "Jarvis: \(GlanceText.approvals(snapshot.pendingApprovals))" }
        if snapshot.isStale() { return "Jarvis: can’t reach your Mac" }
        return "Jarvis: " + (GlanceText.code(snapshot) ?? "all quiet")
    }
}

/// The Lock Screen's rectangle (and the Watch's): three short lines.
struct RectangularGlance: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "sparkle")
                    .font(.caption2.weight(.bold))
                    .widgetAccentable()
                Text("JARVIS")
                    .font(.headline)
                    .widgetAccentable()
                if let snapshot, snapshot.isStale() {
                    Text("· Offline")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let snapshot {
                lines(snapshot)
            } else {
                Text("Pair with your Mac")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func lines(_ snapshot: WidgetSnapshot) -> some View {
        if snapshot.pendingApprovals > 0 {
            Text(GlanceText.approvals(snapshot.pendingApprovals))
                .font(.caption.weight(.semibold))
        } else if let code = GlanceText.code(snapshot) {
            Text(code)
                .font(.caption.weight(.semibold))
        }
        if let next = snapshot.nextEvent, next.begin > Date().addingTimeInterval(-10 * 60) {
            HStack(spacing: 3) {
                Text(next.begin, style: .time)
                    .monospacedDigit()
                Text(next.title)
                    .privacySensitive()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        } else if snapshot.pendingApprovals == 0, GlanceText.code(snapshot) == nil {
            Text(snapshot.isStale() ? "Last heard \(snapshot.updatedAt.formatted(.relative(presentation: .named)))" : "All quiet")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// One line above the clock (and on the Watch face).
struct InlineGlance: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        if let snapshot {
            if snapshot.pendingApprovals > 0 {
                Label(GlanceText.approvals(snapshot.pendingApprovals), systemImage: "hand.raised.fill")
            } else if let code = GlanceText.code(snapshot) {
                Label(code, systemImage: "chevron.left.forwardslash.chevron.right")
            } else if let next = snapshot.nextEvent, next.begin > Date() {
                Label {
                    Text("\(next.title) \(next.begin.formatted(date: .omitted, time: .shortened))")
                } icon: {
                    Image(systemName: "calendar")
                }
            } else {
                Label(snapshot.isStale() ? "Jarvis · Offline" : "Jarvis · All quiet", systemImage: "sparkle")
            }
        } else {
            Label("Jarvis · Pair with your Mac", systemImage: "link")
        }
    }
}
