import SwiftUI

/// What's waiting to go to the Mac: kept while it couldn't be reached, sent oldest first
/// when it's back, and let go after an hour.
struct OutboxSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var trying = false

    var body: some View {
        NavigationStack {
            Group {
                if model.queued.isEmpty {
                    ContentUnavailableView {
                        Label("Nothing waiting", systemImage: "tray")
                    } description: {
                        Text("Requests you make while your Mac can’t be reached wait here, and go as soon as it’s back.")
                    }
                } else {
                    GlassList {
                        Section {
                            ForEach(model.queued) { item in
                                row(item)
                                    .swipeActions {
                                        Button("Don’t send", role: .destructive) { model.discard(item) }
                                    }
                            }
                            .glassRow()
                        } footer: {
                            ListFooter("They go to your Mac, oldest first, as soon as it can be reached. Anything still here after an hour isn’t sent. Swipe one to drop it.")
                        }
                    }
                    .glassList()
                }
            }
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
            .navigationTitle("Waiting to send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !model.queued.isEmpty {
                        Button {
                            trying = true
                            Task {
                                await model.retryOutbox()
                                trying = false
                            }
                        } label: {
                            if trying { ProgressView() } else { Text("Try now") }
                        }
                        .disabled(trying)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Radius.sheet + 4)
    }

    private func row(_ item: OutboxItem) -> some View {
        HStack(spacing: Space.s + 2) {
            IconTile(symbol: symbol(for: item.kind))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.label)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text("Kept \(item.createdAt.formatted(date: .omitted, time: .shortened)) · sends until \(item.expiresAt.formatted(date: .omitted, time: .shortened))")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(.vertical, Space.xxs)
        .accessibilityElement(children: .combine)
    }

    private func symbol(for kind: OutboxItem.Kind) -> String {
        switch kind {
        case .ask: "text.bubble.fill"
        case .command: "sparkles"
        case .share: "square.and.arrow.up.fill"
        case .location: "location.fill"
        case .health: "heart.fill"
        case .codeSend: "chevron.left.forwardslash.chevron.right"
        }
    }
}
