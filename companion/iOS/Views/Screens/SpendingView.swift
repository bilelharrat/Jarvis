import SwiftUI

/// What Jarvis has spent for you lately, against the limits set on the Mac.
struct SpendingView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<Spending> = .loading

    var body: some View {
        Group {
            if let spending = state.value {
                content(spending)
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Spending")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func content(_ spending: Spending) -> some View {
        let currency = spending.limits.currency
        return List {
            Section {
                today(spending)
                    .listRowInsets(EdgeInsets(top: Space.m, leading: Space.m, bottom: Space.m, trailing: Space.m))
            }
            .glassRow()

            Section {
                limit("Each purchase", spending.limits.purchase, currency: currency, symbol: "cart.fill")
                limit("Each transfer", spending.limits.transfer, currency: currency, symbol: "arrow.left.arrow.right")
                limit("In a day", spending.limits.day, currency: currency, symbol: "calendar")
            } header: {
                ListHeader("Limits")
            } footer: {
                ListFooter("Jarvis asks you before every purchase or transfer, and never goes past these. Change them in Jarvis Settings on your Mac.")
            }
            .glassRow()

            Section {
                if spending.recent.isEmpty {
                    Text("Nothing spent lately.")
                        .foregroundStyle(Palette.muted)
                } else {
                    ForEach(spending.recent) { item in
                        row(item)
                    }
                }
            } header: {
                ListHeader("Recent")
            }
            .glassRow()
        }
        .glassList()
    }

    private func today(_ spending: Spending) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Eyebrow("Today")
            Text(Money.text(spending.todayTotal, currency: spending.limits.currency))
                .font(.system(.largeTitle, design: .serif).weight(.medium).monospacedDigit())
                .foregroundStyle(Palette.ink)
                .contentTransition(.numericText())
            if let used = spending.dayUsed, let day = spending.limits.day {
                ProgressView(value: used)
                    .tint(used >= 0.8 ? Palette.amber : Palette.cyan)
                Text("of \(Money.limit(day, currency: spending.limits.currency)) a day")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func limit(_ title: String, _ amount: Double?, currency: String, symbol: String) -> some View {
        LabeledContent {
            Text(amount.map { Money.limit($0, currency: currency) } ?? "No limit")
                .font(.body.monospacedDigit())
                .foregroundStyle(Palette.ink2)
        } label: {
            HStack(spacing: Space.s) {
                IconTile(symbol: symbol)
                Text(title).foregroundStyle(Palette.ink)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func row(_ item: SpendItem) -> some View {
        HStack(spacing: Space.s) {
            IconTile(symbol: item.kind == "transfer" ? "arrow.left.arrow.right" : "cart.fill")
            VStack(alignment: .leading, spacing: 2) {
                Text(item.merchant)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Text([item.kind.capitalizedFirst, item.at.map { $0.formatted(.dateTime.month(.abbreviated).day().hour().minute()) }].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
            Spacer(minLength: Space.xs)
            Text(Money.text(item.amount, currency: item.currency))
                .font(.body.weight(.medium).monospacedDigit())
                .foregroundStyle(Palette.ink)
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            state = .loaded(try await api.spending())
        } catch is CancellationError {
        } catch {
            guard model.handle(error) != nil else { return }
            if state.value == nil { state = .from(error) }
        }
    }
}
