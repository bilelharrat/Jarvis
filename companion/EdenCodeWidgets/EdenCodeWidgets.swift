import ActivityKit
import SwiftUI
import WidgetKit

/// Eden Code's widgets: the Lock Screen and Dynamic Island for a running session (the
/// companion's Live Activity attributes, updated by the Mac's pushes), and a Home Screen /
/// Lock Screen widget with what needs you and what's running (the app's snapshot in the
/// App Group).
@main
struct EdenCodeWidgetBundle: WidgetBundle {
    var body: some Widget {
        EdenCodeStatusWidget()
        EdenCodeLiveActivity()
    }
}

private let blue = Color(red: 0, green: 122 / 255, blue: 1)
private let orange = Color(red: 1, green: 149 / 255, blue: 0)
private let green = Color(red: 52 / 255, green: 199 / 255, blue: 89 / 255)
private let red = Color(red: 1, green: 59 / 255, blue: 48 / 255)

private func dot(_ status: String) -> Color {
    switch status {
    case "working", "Working": blue
    case "needs_you", "Needs you": orange
    case "done", "Done": green
    case "failed", "Failed": red
    default: .gray
    }
}

private func sessionURL(_ id: String) -> URL { URL(string: "edencode://session/\(id)") ?? URL(string: "edencode://sessions")! }

// MARK: - Live Activity

struct EdenCodeLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JarvisActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Circle().fill(dot(context.state.status)).frame(width: 12, height: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.title).font(.headline).lineLimit(1)
                    Text([context.state.status, context.state.detail].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text("Eden Code").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(16)
            .activityBackgroundTint(nil)
            .widgetURL(sessionURL(context.attributes.itemID))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Eden Code", systemImage: "chevron.left.forwardslash.chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(context.state.needsYou ? orange : blue)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.status).font(.caption.weight(.semibold)).foregroundStyle(dot(context.state.status))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title).font(.headline).lineLimit(1)
                        if !context.state.detail.isEmpty { Text(context.state.detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
                    }
                }
            } compactLeading: {
                Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(blue)
            } compactTrailing: {
                Circle().fill(dot(context.state.status)).frame(width: 10, height: 10)
            } minimal: {
                Circle().fill(dot(context.state.status)).frame(width: 10, height: 10)
            }
            .widgetURL(sessionURL(context.attributes.itemID))
        }
    }
}

// MARK: - Status widget

struct StatusEntry: TimelineEntry {
    var date: Date
    var snapshot: EdenWidgetSnapshot
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry { StatusEntry(date: Date(), snapshot: .placeholder) }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(StatusEntry(date: Date(), snapshot: WidgetSnapshotStore.load() ?? .placeholder))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        let snapshot = WidgetSnapshotStore.load() ?? EdenWidgetSnapshot(mac: "", needsYou: 0, working: 0, items: [], at: Date())
        completion(Timeline(entries: [StatusEntry(date: Date(), snapshot: snapshot)], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
}

struct EdenCodeStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "EdenCodeStatus", provider: StatusProvider()) { entry in
            StatusWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Eden Code")
        .description("What needs you, and what's running.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular])
    }
}

struct StatusWidgetView: View {
    var entry: StatusEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let s = entry.snapshot
        switch family {
        case .accessoryCircular:
            Gauge(value: Double(s.needsYou), in: 0...Double(max(1, s.needsYou))) { Image(systemName: "hand.raised.fill") } currentValueLabel: { Text("\(s.needsYou)") }
                .gaugeStyle(.accessoryCircularCapacity)
                .widgetURL(URL(string: "edencode://inbox"))
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("Eden Code").font(.headline)
                Text("\(s.needsYou) need you · \(s.working) running").font(.caption)
            }
            .widgetURL(URL(string: "edencode://inbox"))
        default:
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Eden Code").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    if s.needsYou > 0 {
                        Text("\(s.needsYou)").font(.caption.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(orange, in: .capsule)
                    }
                }
                if s.items.isEmpty {
                    Spacer()
                    Text("No sessions").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                } else {
                    ForEach(s.items.prefix(family == .systemSmall ? 3 : 4), id: \.id) { item in
                        Link(destination: sessionURL(String(item.id))) {
                            HStack(spacing: 6) {
                                Circle().fill(dot(item.status)).frame(width: 8, height: 8)
                                Text(item.title).font(.caption).lineLimit(1)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}
