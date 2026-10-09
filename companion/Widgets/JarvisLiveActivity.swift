import ActivityKit
import SwiftUI
import WidgetKit

/// The Lock Screen card and Dynamic Island for an Eden Code session, a conversation held
/// for you, a call, or a video summary.
struct JarvisLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JarvisActivityAttributes.self) { context in
            LockScreenActivity(attributes: context.attributes, state: context.state, stale: context.isStale)
                .activityBackgroundTint(Palette.space.opacity(0.92))
                .activitySystemActionForegroundColor(Palette.ice)
                .widgetURL(context.attributes.destination.url)
        } dynamicIsland: { context in
            let tint = context.state.needsYou ? Palette.champagne : Palette.cyan
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.kind.label)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Palette.ink2)
                    } icon: {
                        Image(systemName: context.attributes.kind.symbol)
                            .foregroundStyle(tint)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StatusBadge(state: context.state)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.state.title)
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                        if !context.state.detail.isEmpty {
                            Text(context.state.detail)
                                .font(.subheadline)
                                .foregroundStyle(Palette.ink2)
                                .lineLimit(2)
                        }
                        if let progress = context.state.progress {
                            ProgressView(value: progress)
                                .tint(tint)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: context.attributes.kind.symbol)
                    .foregroundStyle(tint)
            } compactTrailing: {
                CompactStatus(state: context.state)
            } minimal: {
                Image(systemName: context.state.needsYou ? "hand.raised.fill" : context.attributes.kind.symbol)
                    .foregroundStyle(tint)
            }
            .widgetURL(context.attributes.destination.url)
            .keylineTint(tint)
        }
    }
}

private struct LockScreenActivity: View {
    let attributes: JarvisActivityAttributes
    let state: JarvisActivityAttributes.ContentState
    let stale: Bool

    var body: some View {
        let tint = state.needsYou ? Palette.champagne : Palette.cyan
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: attributes.kind.symbol)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(tint.opacity(0.14)))
                    .overlay(Circle().strokeBorder(tint.opacity(0.35), lineWidth: 0.75))
                VStack(alignment: .leading, spacing: 2) {
                    Text(attributes.kind.label.uppercased())
                        .font(.caption2.weight(.semibold))
                        .tracking(0.9)
                        .foregroundStyle(Palette.muted)
                    Text(state.title)
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    if !state.detail.isEmpty {
                        Text(state.detail)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                StatusBadge(state: state)
            }
            if let progress = state.progress {
                ProgressView(value: progress)
                    .tint(tint)
            }
        }
        .padding(16)
        .opacity(stale ? 0.7 : 1)
    }
}

/// "Working", "Needs you", or how far along.
private struct StatusBadge: View {
    let state: JarvisActivityAttributes.ContentState

    var body: some View {
        let tint = state.needsYou ? Palette.champagne : Palette.ice
        VStack(alignment: .trailing, spacing: 2) {
            if state.needsYou {
                Label("Needs you", systemImage: "hand.raised.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .labelStyle(.titleAndIcon)
            } else if let progress = state.progress {
                Text(progress, format: .percent.precision(.fractionLength(0)))
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(tint)
            } else if !state.status.isEmpty {
                Text(state.status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
            }
            Text(state.updated, style: .relative)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.trailing)
        }
    }
}

/// The Dynamic Island's right edge: a hand when it needs you, else how far along or a dot.
private struct CompactStatus: View {
    let state: JarvisActivityAttributes.ContentState

    var body: some View {
        if state.needsYou {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(Palette.champagne)
        } else if let progress = state.progress {
            Text(progress, format: .percent.precision(.fractionLength(0)))
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(Palette.ice)
        } else {
            Circle()
                .fill(Palette.cyan)
                .frame(width: 8, height: 8)
        }
    }
}
