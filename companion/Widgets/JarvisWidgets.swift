import SwiftUI
import WidgetKit

@main
struct JarvisWidgetBundle: WidgetBundle {
    var body: some Widget {
        JarvisStatusWidget()
        JarvisCodeWidget()
        JarvisLiveActivityWidget()
        TalkToJarvisControl()
    }
}

/// Control Center, the Lock Screen and the Action Button: one press and Jarvis is listening.
struct TalkToJarvisControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.askeden.jarvis.talk") {
            ControlWidgetButton(action: TalkToJarvisIntent()) {
                Label("Talk to Jarvis", systemImage: "waveform.circle.fill")
            }
        }
        .displayName("Talk to Jarvis")
        .description("Opens Jarvis, listening.")
    }
}

/// Your Mac at a glance: whether it's there, what needs your OK, what's next.
struct JarvisStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JarvisStatus", provider: SnapshotProvider()) { entry in
            StatusWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
        }
        .configurationDisplayName("Jarvis")
        .description("Your Mac, what needs your OK, and what’s next.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

/// Eden Code sessions: the ones that need you, and the ones working.
struct JarvisCodeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JarvisCode", provider: SnapshotProvider()) { entry in
            CodeWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
        }
        .configurationDisplayName("Eden Code")
        .description("Sessions that need you, and the ones working.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

// MARK: - Jarvis

struct StatusWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular: CircularGlance(snapshot: entry.snapshot).widgetURL(Destination.home.url)
        case .accessoryRectangular: RectangularGlance(snapshot: entry.snapshot).widgetURL(Destination.home.url)
        case .accessoryInline: InlineGlance(snapshot: entry.snapshot).widgetURL(Destination.home.url)
        case .systemMedium: medium
        default: small
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(snapshot: entry.snapshot)
            Spacer(minLength: 6)
            if let snapshot = entry.snapshot {
                SmallStatus(snapshot: snapshot, now: entry.date)
            } else {
                NotPaired()
            }
        }
        .widgetURL(Destination.home.url)
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                WidgetHeader(snapshot: entry.snapshot)
                Spacer(minLength: 6)
                if let snapshot = entry.snapshot {
                    SmallStatus(snapshot: snapshot, now: entry.date)
                } else {
                    NotPaired()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let snapshot = entry.snapshot {
                Rectangle().fill(Palette.hairline).frame(width: 0.5)
                VStack(alignment: .leading, spacing: 8) {
                    if let question = snapshot.approvalQuestion, snapshot.pendingApprovals > 0 {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(snapshot.approvalFromCode ? "JARVIS CODE ASKS" : "JARVIS ASKS")
                                .font(.caption2.weight(.semibold))
                                .tracking(0.8)
                                .foregroundStyle(Palette.champagne)
                            Text(question)
                                .font(.system(.footnote, design: .serif).weight(.medium))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(3)
                                .privacySensitive()
                        }
                    }
                    if let next = snapshot.nextEvent, next.begin > entry.date.addingTimeInterval(-10 * 60) {
                        NextEventLine(event: next)
                    }
                    if snapshot.pendingApprovals == 0, snapshot.nextEvent == nil {
                        Text(GlanceText.code(snapshot) ?? "Nothing on the calendar.")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetURL(Destination.home.url)
    }
}

/// The wordmark and whether the Mac is there.
private struct WidgetHeader: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        HStack(spacing: 6) {
            OrbMark(size: 11)
            Text("JARVIS")
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(Palette.ink2)
            Spacer(minLength: 0)
            if let snapshot {
                Circle()
                    .fill(snapshot.isStale() ? Palette.amber : Palette.online)
                    .frame(width: 6, height: 6)
                    .accessibilityLabel(snapshot.isStale() ? "Can’t reach your Mac" : "Connected")
            }
        }
    }
}

/// The small widget's body: what needs you first, else what's next, else all quiet.
private struct SmallStatus: View {
    let snapshot: WidgetSnapshot
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if snapshot.pendingApprovals > 0 {
                Text("\(snapshot.pendingApprovals)")
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Palette.champagne)
                Text(snapshot.pendingApprovals == 1 ? "needs your OK" : "need your OK")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.champagne)
            } else if let next = snapshot.nextEvent, next.begin > now.addingTimeInterval(-10 * 60) {
                NextEventLine(event: next)
            } else if snapshot.isStale() {
                Text("Offline")
                    .font(.system(.title3, design: .serif).weight(.medium))
                    .foregroundStyle(Palette.amber)
                Text(snapshot.updatedAt == .distantPast ? snapshot.macName : "Last heard \(snapshot.updatedAt.formatted(.relative(presentation: .named)))")
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(2)
            } else {
                Text("All quiet")
                    .font(.system(.title3, design: .serif).weight(.medium))
                    .foregroundStyle(Palette.ink)
                Text(GlanceText.code(snapshot) ?? snapshot.macName)
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(2)
            }
        }
    }
}

private struct NextEventLine: View {
    let event: WidgetSnapshot.Event

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text("NEXT")
                    .font(.caption2.weight(.semibold))
                    .tracking(0.8)
                    .foregroundStyle(Palette.muted)
                Text(event.begin, style: .time)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Palette.ice)
            }
            Text(event.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .privacySensitive()
        }
    }
}

private struct NotPaired: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Not paired")
                .font(.system(.title3, design: .serif).weight(.medium))
                .foregroundStyle(Palette.ink)
            Text("Open J.A.R.V.I.S. to pair with your Mac.")
                .font(.caption)
                .foregroundStyle(Palette.muted)
        }
    }
}

// MARK: - Eden Code

struct CodeWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    private var sessions: [CodeSessionSummary] { entry.snapshot?.codeSessions ?? [] }

    var body: some View {
        switch family {
        case .accessoryCircular: circular.widgetURL(Destination.code.url)
        case .accessoryRectangular: rectangular.widgetURL(link(for: sessions.first))
        case .systemMedium: medium
        default: small
        }
    }

    private func link(for session: CodeSessionSummary?) -> URL {
        (session.map { Destination.codeSession($0.id) } ?? .code).url
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            Spacer(minLength: 4)
            if let snapshot = entry.snapshot {
                if snapshot.needsYouCount > 0 {
                    count(snapshot.needsYouCount, snapshot.needsYouCount == 1 ? "needs you" : "need you", tint: Palette.champagne)
                } else if snapshot.workingCount > 0 {
                    count(snapshot.workingCount, "working", tint: Palette.ice)
                } else {
                    Text("Nothing running")
                        .font(.system(.title3, design: .serif).weight(.medium))
                        .foregroundStyle(Palette.ink)
                }
                if let first = sessions.first, first.status.isLive {
                    Text(first.title)
                        .font(.caption)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(2)
                        .privacySensitive()
                }
            } else {
                NotPaired()
            }
        }
        .widgetURL(link(for: sessions.first { $0.status == .needsYou } ?? (sessions.count == 1 ? sessions.first : nil)))
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if entry.snapshot == nil {
                NotPaired()
            } else if sessions.isEmpty {
                Spacer(minLength: 0)
                Text("No sessions right now.")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            } else {
                ForEach(sessions.prefix(3)) { session in
                    Link(destination: Destination.codeSession(session.id).url) {
                        HStack(spacing: 8) {
                            Image(systemName: session.status.symbol)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(tint(session.status))
                                .frame(width: 16)
                            Text(session.title)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(1)
                                .privacySensitive()
                            Spacer(minLength: 4)
                            Text(session.status.label)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(tint(session.status))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(Destination.code.url)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Palette.cyan)
            Text("JARVIS CODE")
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(Palette.ink2)
            Spacer(minLength: 0)
            if let snapshot = entry.snapshot, snapshot.isStale() {
                Circle().fill(Palette.amber).frame(width: 6, height: 6)
                    .accessibilityLabel("Can’t reach your Mac")
            }
        }
    }

    private func count(_ value: Int, _ label: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(value)")
                .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(tint)
            Text(label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(tint)
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: (entry.snapshot?.needsYouCount ?? 0) > 0 ? "hand.raised.fill" : "chevron.left.forwardslash.chevron.right")
                    .font(.caption.weight(.semibold))
                Text("\((entry.snapshot?.needsYouCount ?? 0) + (entry.snapshot?.workingCount ?? 0))")
                    .font(.title3.weight(.semibold).monospacedDigit())
            }
        }
        .widgetAccentable()
        .accessibilityLabel(entry.snapshot.flatMap(GlanceText.code) ?? "Eden Code: nothing running")
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Eden Code")
                .font(.headline)
                .widgetAccentable()
            if let first = sessions.first, first.status.isLive {
                Text(first.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .privacySensitive()
                Text(first.status.label + (sessions.count > 1 ? " · \(sessions.filter(\.status.isLive).count - 1) more" : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Nothing running")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tint(_ status: CodeStatus) -> Color {
        switch status {
        case .working: Palette.cyan
        case .needsYou: Palette.champagne
        case .done: Palette.online
        case .failed: Palette.amber
        default: Palette.muted
        }
    }
}
