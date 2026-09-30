import SwiftUI

/// Everything beyond the conversation, one tap from the top bar: Jarvis Code, conversations
/// held for you, routines, what you missed, spending. Inset grouped on glass, like Settings.
struct MoreSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Destination]
    @AppStorage(SensorSettings.cameraKey) private var camera = false

    init(start: Destination? = nil) {
        _path = State(initialValue: start.flatMap { $0 == .home ? nil : $0 }.map { Self.stack(for: $0) } ?? [])
    }

    /// A session opens over the list of sessions, so Back goes where you'd expect.
    private static func stack(for destination: Destination) -> [Destination] {
        if case .codeSession = destination { return [.code, destination] }
        return [destination]
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    link(.code, "Jarvis Code", symbol: "chevron.left.forwardslash.chevron.right", detail: codeDetail, attention: needsYou > 0)
                    link(.conversations, "Conversations for you", symbol: "bubble.left.and.bubble.right.fill", detail: conversationsDetail)
                    link(.routines, "Routines", symbol: "bolt.fill", detail: nil)
                } header: {
                    ListHeader("On your Mac")
                }
                .glassRow()

                Section {
                    link(.digest, "What did I miss", symbol: "tray.full.fill", detail: nil)
                    link(.spending, "Spending", symbol: "creditcard.fill", detail: nil)
                    if camera {
                        link(.showJarvis, "Show Jarvis", symbol: "camera.fill", detail: nil)
                    }
                } header: {
                    ListHeader("For you")
                }
                .glassRow()

                if !model.queued.isEmpty {
                    Section {
                        link(.outbox, "Waiting to send", symbol: "tray.and.arrow.up.fill", detail: "\(model.queued.count)", attention: true)
                    } footer: {
                        ListFooter("Kept while your Mac couldn’t be reached. They go when it’s back.")
                    }
                    .glassRow()
                }
            }
            .glassList()
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
            .navigationTitle("Jarvis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .navigationDestination(for: Destination.self) { destination in
                screen(for: destination)
            }
        }
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Radius.sheet + 4)
    }

    @ViewBuilder
    private func screen(for destination: Destination) -> some View {
        switch destination {
        case .code: CodeSessionsView()
        case .codeSession(let id): CodeSessionView(sessionID: id)
        case .conversations: ConversationsView()
        case .routines: RoutinesView()
        case .digest: DigestView()
        case .spending: SpendingView()
        case .outbox: OutboxList()
        case .showJarvis: ShowJarvisView()
        case .home: EmptyView()
        }
    }

    private func link(_ destination: Destination, _ title: String, symbol: String, detail: String?, attention: Bool = false) -> some View {
        NavigationLink(value: destination) {
            HStack(spacing: Space.s) {
                IconTile(symbol: symbol, tint: attention ? Palette.champagne : Palette.ink)
                Text(title)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: Space.xs)
                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(attention ? Palette.champagne : Palette.muted)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
    }

    private var needsYou: Int { model.remote?.codeSessions.filter { $0.status == .needsYou }.count ?? 0 }

    private var codeDetail: String? {
        let sessions = model.remote?.codeSessions ?? []
        let working = sessions.filter { $0.status == .working }.count
        if needsYou > 0 { return needsYou == 1 ? "Needs you" : "\(needsYou) need you" }
        return working > 0 ? "\(working) working" : nil
    }

    private var conversationsDetail: String? {
        guard let active = model.remote?.delegationsActive, active > 0 else { return nil }
        return "\(active) active"
    }
}

/// The outbox as a screen inside the hub (the sheet version shows from the banner).
private struct OutboxList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                ForEach(model.queued) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.label)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                        Text("Kept \(item.createdAt.formatted(date: .omitted, time: .shortened)) · sends until \(item.expiresAt.formatted(date: .omitted, time: .shortened))")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                    .swipeActions {
                        Button("Don’t send", role: .destructive) { model.discard(item) }
                    }
                }
            } footer: {
                ListFooter("They go to your Mac, oldest first, as soon as it can be reached. Anything still here after an hour isn’t sent.")
            }
            .glassRow()
        }
        .glassList()
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Waiting to send")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if model.queued.isEmpty {
                ContentUnavailableView("Nothing waiting", systemImage: "tray", description: Text("Everything reached your Mac."))
            }
        }
    }
}
