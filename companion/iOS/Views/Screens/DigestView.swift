import SwiftUI

/// What you missed in the last day: texts, emails, calls and voicemails, summarized on the
/// Mac (never the messages themselves), urgent ones first.
struct DigestView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<Digest> = .loading

    var body: some View {
        Group {
            if let digest = state.value {
                if digest.items.isEmpty {
                    ContentUnavailableView {
                        Label("Nothing new", systemImage: "checkmark.circle")
                    } description: {
                        Text("No texts, emails or calls for you in the last day.")
                    }
                } else {
                    list(digest)
                }
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("What did I miss")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func list(_ digest: Digest) -> some View {
        GlassList {
            Section {
                ForEach(Array(digest.sorted.enumerated()), id: \.offset) { _, item in
                    row(item)
                }
            } header: {
                ListHeader("The last 24 hours")
            } footer: {
                ListFooter("Summaries from Jarvis on your Mac. Ask Jarvis to read or answer any of them.")
            }
            .glassRow()
        }
        .glassList()
    }

    private func row(_ item: DigestItem) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            IconTile(symbol: item.kind.symbol, tint: item.urgent ? Palette.amber : Palette.ink)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.xs) {
                    Text(item.who)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    if item.urgent {
                        StatusPill(text: "Urgent", tint: Palette.amber)
                    }
                    Spacer(minLength: Space.xxs)
                    if let at = item.at {
                        Text(at.ago)
                            .font(.caption)
                            .foregroundStyle(Palette.muted)
                    }
                }
                Text(item.summary.isEmpty ? item.kind.label : item.summary)
                    .font(.subheadline)
                    .foregroundStyle(item.summary.isEmpty ? Palette.muted : Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.xxs)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            state = .loaded(try await api.digest())
        } catch is CancellationError {
        } catch {
            guard model.handle(error) != nil else { return }
            if state.value == nil { state = .from(error) }
        }
    }
}
