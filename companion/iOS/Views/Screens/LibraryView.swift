import SwiftUI

/// Everything beyond the conversation, grouped like Settings: what Jarvis does on your Mac,
/// what it keeps for you, and what it does on this iPhone.
struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool

    var body: some View {
        List {
            if model.pairing != nil {
                Section("On Your Mac") {
                    link(.conversations, "Conversations for You", symbol: "bubble.left.and.bubble.right.fill", tint: .green, detail: conversationsDetail)
                    link(.routines, "Routines", symbol: "bolt.fill", tint: .orange)
                    ForEach(MacFeature.allCases.filter { model.macFeatures.contains($0.rawValue) }) { feature in
                        link(.mac(feature), feature.title, symbol: feature.symbol, tint: feature.tint)
                    }
                }

                Section("For You") {
                    link(.digest, "What Did I Miss", symbol: "tray.full.fill", tint: .indigo)
                    link(.spending, "Spending", symbol: "creditcard.fill", tint: .teal)
                }
            }

            Section {
                link(.showJarvis, "Show Jarvis", symbol: "camera.fill", tint: .gray)
                link(.phoneMemory, "What Jarvis Remembers", symbol: "brain.head.profile", tint: .pink)
                link(.heyJarvis, "“Hey Jarvis” and the Action Button", symbol: "waveform", tint: .purple)
            } header: {
                Text("On This iPhone")
            } footer: {
                if model.pairing == nil {
                    Text("Pair your Mac in Settings to reach Jarvis Code, routines, your files, mail and everything else Jarvis does on your Mac.")
                }
            }

            if !model.queued.isEmpty {
                Section {
                    link(.outbox, "Waiting to Send", symbol: "tray.and.arrow.up.fill", tint: .orange, detail: "\(model.queued.count)")
                } footer: {
                    Text("Kept while your Mac couldn’t be reached. They go when it’s back.")
                }
            }
        }
        .navigationTitle("Library")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
        }
    }

    @ViewBuilder
    static func screen(for destination: Destination) -> some View {
        switch destination {
        case .code: CodeSessionsView()
        case .codeSession(let id): CodeSessionView(sessionID: id)
        case .conversations: ConversationsView()
        case .routines: RoutinesView()
        case .digest: DigestView()
        case .spending: SpendingView()
        case .outbox: OutboxList()
        case .showJarvis: ShowJarvisView()
        case .phoneMemory: PhoneMemoryView()
        case .heyJarvis: HeyJarvisView()
        case .mac(let feature): MacFeatureView(feature: feature)
        case .home: EmptyView()
        }
    }

    private func link(_ destination: Destination, _ title: String, symbol: String, tint: Color, detail: String? = nil) -> some View {
        NavigationLink(value: destination) {
            HStack(spacing: Space.s) {
                IconTile(symbol: symbol, tint: tint)
                Text(title)
                Spacer(minLength: Space.xs)
                if let detail {
                    Text(detail)
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
    }

    private var conversationsDetail: String? {
        guard let active = model.remote?.delegationsActive, active > 0 else { return nil }
        return "\(active) active"
    }
}

/// The outbox as a screen in the Library (the sheet version shows from the banner).
struct OutboxList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                ForEach(model.queued) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.label)
                            .lineLimit(2)
                        Text("Kept \(item.createdAt.formatted(date: .omitted, time: .shortened)) · sends until \(item.expiresAt.formatted(date: .omitted, time: .shortened))")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                    .swipeActions {
                        Button("Don’t Send", role: .destructive) { model.discard(item) }
                    }
                }
            } footer: {
                Text("They go to your Mac, oldest first, as soon as it can be reached. Anything still here after an hour isn’t sent.")
            }
        }
        .navigationTitle("Waiting to Send")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if model.queued.isEmpty {
                ContentUnavailableView("Nothing Waiting", systemImage: "tray", description: Text("Everything reached your Mac."))
            }
        }
    }
}

/// The facts Jarvis on the iPhone keeps about you; swipe to forget one.
struct PhoneMemoryView: View {
    @State private var facts = LocalMemory.shared.facts
    @State private var adding = ""

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Something Jarvis should know", text: $adding)
                        .submitLabel(.done)
                        .onSubmit(add)
                    Button("Add", action: add)
                        .disabled(adding.trimmed.isEmpty)
                }
            } footer: {
                Text("Jarvis on this iPhone also remembers what you tell it to (“remember that I take my coffee black”). Kept on this iPhone only.")
            }
            if !facts.isEmpty {
                Section("Remembered") {
                    ForEach(facts.reversed()) { fact in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fact.text)
                            Text(fact.date.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption)
                                .foregroundStyle(Palette.muted)
                        }
                        .swipeActions {
                            Button("Forget", role: .destructive) {
                                LocalMemory.shared.remove(fact)
                                facts = LocalMemory.shared.facts
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func add() {
        let text = adding.trimmed
        guard !text.isEmpty else { return }
        LocalMemory.shared.add(text)
        facts = LocalMemory.shared.facts
        adding = ""
    }
}
