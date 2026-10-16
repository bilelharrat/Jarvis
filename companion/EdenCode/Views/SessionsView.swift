import SwiftUI

/// The Sessions tab (PhoneSessions mockup): the Mac picker and +, the large title, search,
/// the Needs-you banner, the pin from a handoff, sessions grouped by project with their
/// status dots, Exterminator Mode's runs, and the usage glance.
struct SessionsView: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                TextField("Search", text: $store.search)
                    .font(.system(size: 16))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(EdenTheme.fill.opacity(1.15), in: .rect(cornerRadius: 11))
                    .padding(.horizontal, 4)
                    .accessibilityLabel("Search sessions")
                if let problem = store.problem {
                    ProblemBanner(text: problem)
                }
                if store.home.needsYouCount > 0 { needsYou }
                if let pinned = store.home.pinned {
                    Button { store.open(session: pinned.id) } label: {
                        bannerRow(symbol: "iphone.and.arrow.forward", tint: EdenTheme.accent, title: "From your Mac", subtitle: pinned.title)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(groups, id: \.project) { group in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(group.project.uppercased())
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(EdenTheme.muted)
                            .padding(.horizontal, 6)
                            .accessibilityAddTraits(.isHeader)
                        VStack(spacing: 0) {
                            ForEach(Array(group.sessions.enumerated()), id: \.element.id) { index, session in
                                NavigationLink(value: EdenCodeStore.Route.session(session.id)) {
                                    SessionRow(session: session, waiting: store.home.attention.first { $0.taskID == session.id })
                                }
                                .buttonStyle(.plain)
                                if index < group.sessions.count - 1 { Divider().overlay(EdenTheme.divider).padding(.leading, 36) }
                            }
                        }
                        .edenCard()
                    }
                }
                if store.loaded && groups.isEmpty && store.problem == nil {
                    emptyState
                }
                if !store.home.exterminator.isEmpty { exterminator }
                UsageGlance(usage: store.usage)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .background(EdenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await store.refreshAll() }
    }

    private var groups: [(project: String, sessions: [PhoneSummary])] {
        let query = store.search.trimmed.lowercased()
        return store.home.byProject.compactMap { group in
            let kept = query.isEmpty ? group.sessions : group.sessions.filter {
                $0.title.lowercased().contains(query) || $0.project.lowercased().contains(query)
            }
            return kept.isEmpty ? nil : (group.project, kept)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                MacPicker()
                Spacer()
                Button { store.showNewSession = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(EdenTheme.accent, in: .circle)
                        .shadow(color: EdenTheme.accent.opacity(0.35), radius: 8, y: 6)
                }
                .buttonStyle(PressScale(scale: 0.94))
                .accessibilityLabel("New session")
            }
            Text("Sessions")
                .font(.system(size: 34, weight: .bold))
                .tracking(-0.68)
                .foregroundStyle(EdenTheme.ink)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.top, 12)
        .padding(.horizontal, 4)
    }

    private var needsYou: some View {
        Button { store.tab = .inbox } label: {
            HStack(spacing: 12) {
                Text("\(store.home.needsYouCount)")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(EdenTheme.orange, in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Needs you").font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                    Text(InboxView.summary(store.home.attention)).font(.system(size: 13)).foregroundStyle(EdenTheme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.chevron)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(EdenTheme.orange.opacity(0.16), in: .rect(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(EdenTheme.cardRim.opacity(0.8), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Needs you, \(store.home.needsYouCount). \(InboxView.summary(store.home.attention))")
    }

    private func bannerRow(symbol: String, tint: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 34, height: 34).background(tint, in: .rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                Text(subtitle).font(.system(size: 13)).foregroundStyle(EdenTheme.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.chevron)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .edenCard()
    }

    private var exterminator: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("EXTERMINATOR MODE").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.muted).padding(.horizontal, 6)
            VStack(spacing: 0) {
                ForEach(store.home.exterminator) { run in
                    Button { if let id = run.taskID { store.open(session: id) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "ant.fill").foregroundStyle(EdenTheme.orange)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(run.project).font(.system(size: 15, weight: .medium)).foregroundStyle(EdenTheme.ink)
                                Text(run.line).font(.system(size: 13)).foregroundStyle(EdenTheme.muted)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                    }
                    .buttonStyle(.plain)
                }
            }
            .edenCard()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "chevron.left.forwardslash.chevron.right").font(.system(size: 30)).foregroundStyle(EdenTheme.accent)
            Text("No sessions yet").font(.headline).foregroundStyle(EdenTheme.ink)
            Text("Start one here, or on your Mac. It shows up here as it works.")
                .font(.subheadline).foregroundStyle(EdenTheme.muted).multilineTextAlignment(.center)
            Button("New session") { store.showNewSession = true }.buttonStyle(.glassProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .edenCard(radius: 20)
    }
}

/// One session: its dot, its title, and what it's doing (or waits on).
struct SessionRow: View {
    var session: PhoneSummary
    var waiting: PhoneCard?

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(status: session.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title).font(.system(size: 15, weight: .medium)).foregroundStyle(EdenTheme.ink).lineLimit(1)
                Text(subtitle).font(.system(size: 13)).foregroundStyle(EdenTheme.subtitleInk(session.status)).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.chevron)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.title), \(session.status.label). \(subtitle)")
    }

    private var subtitle: String {
        if let waiting { return waiting.approval.question }
        var parts = [session.status.label]
        if let at = session.updatedAt { parts.append(at.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))) }
        if !session.model.isEmpty { parts.append(session.model) }
        return parts.joined(separator: " · ")
    }
}

/// "MacBook Air ▾": which Mac, and pairing another.
struct MacPicker: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        Menu {
            ForEach(store.macs, id: \.baseURL) { mac in
                Button { store.select(mac) } label: {
                    if store.current.map({ PairingStore.same($0, mac) }) ?? false {
                        Label(mac.macLabel, systemImage: "checkmark")
                    } else {
                        Text(mac.macLabel)
                    }
                }
            }
            Divider()
            Button { store.showPairing = true } label: { Label("Pair another Mac", systemImage: "plus") }
        } label: {
            HStack(spacing: 5) {
                Text(store.current?.macLabel ?? "Your Mac").font(.system(size: 14))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(EdenTheme.ink)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .accessibilityLabel("Mac: \(store.current?.macLabel ?? "none"). Switch Mac")
    }
}

/// Today's spending and the 5-hour window.
struct UsageGlance: View {
    var usage: PhoneUsage?

    var body: some View {
        HStack(spacing: 10) {
            tile("Today", usage.map { Money.text($0.today) + ($0.dayCap > 0 ? " of \(Money.text($0.dayCap))" : "") } ?? "$ —")
            tile(usage?.fiveHour?.label ?? "5-hour limit", usage?.fiveHour?.percent.map { "\(Int($0.rounded()))%" } ?? "—%")
        }
    }

    private func tile(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 12)).foregroundStyle(EdenTheme.muted)
            Text(value).font(.system(size: 22, weight: .bold)).foregroundStyle(EdenTheme.ink).minimumScaleFactor(0.6).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .edenCard()
        .accessibilityElement(children: .combine)
    }
}

struct ProblemBanner: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 13))
            .foregroundStyle(EdenTheme.ink)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EdenTheme.orange.opacity(0.14), in: .rect(cornerRadius: 14))
    }
}
