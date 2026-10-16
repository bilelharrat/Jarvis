import SwiftUI

/// The sessions drawer (G2, GDrawer.dc.html): a pane of glass 320 pt wide from the left, over
/// the session. Search, New session, then ONE flat list grouped Today, Yesterday and Earlier:
/// each a name and, today, one coloured word (orange "Needs your OK", blue "Working…" with a
/// spinner, green "Done"), the open one lit. What waits on the owner leads Today. Below: the
/// Inbox and the Queue, then the Mac in use (tap to switch or pair another) and Settings.
struct SessionDrawer: View {
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.colorScheme) private var scheme

    private var dark: Bool { scheme == .dark }

    var body: some View {
        // The list scrolls in its own region, clipped, fading out just above the Inbox, the
        // Queue and the Mac, which stay pinned below it (on TestFlight 2 the last sessions
        // drew over them).
        VStack(alignment: .leading, spacing: 0) {
            top
            list
                .frame(maxHeight: .infinity)
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 18)
                    }
                }
                .clipped()
                .layoutPriority(-1)
            shortcuts
                .padding(.top, 6)
                .overlay(alignment: .top) {
                    Rectangle().fill(EdenTheme.divider).frame(height: 1).padding(.horizontal, 18)
                }
                .fixedSize(horizontal: false, vertical: true)
            footer
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: .infinity)
        .background { pane }
    }

    // MARK: - Search and New session

    private var top: some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                SearchGlyph()
                    .stroke(EdenTheme.chevron, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 16, height: 16)
                TextField("", text: $store.search, prompt: Text("Search").foregroundStyle(EdenTheme.muted))
                    .font(.system(size: 16))
                    .foregroundStyle(EdenTheme.ink)
                    .submitLabel(.search)
                    .accessibilityLabel("Search sessions")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(dark ? Color.white.opacity(0.08) : Color.white.opacity(0.5), in: .rect(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .top) { topLine(12) }
            Button { store.startNew() } label: {
                HStack(spacing: 12) {
                    PencilGlyph()
                        .stroke(EdenTheme.ink, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(width: 20, height: 20)
                    Text("New session").font(.system(size: 16, weight: .semibold)).foregroundStyle(EdenTheme.ink)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 9)
        .padding(.bottom, 10)
    }

    // MARK: - The list

    private var groups: [PhoneHome.DrawerGroup] { store.home.drawerGroups(query: store.search) }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if let problem = store.problem {
                    ProblemBanner(text: problem).padding(.horizontal, 2).padding(.bottom, 6)
                }
                ForEach(Array(groups.enumerated()), id: \.element.title) { index, group in
                    Text(group.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(EdenTheme.chevron)
                        .padding(EdgeInsets(top: index == 0 ? 10 : 14, leading: 12, bottom: 4, trailing: 12))
                        .accessibilityAddTraits(.isHeader)
                    ForEach(group.sessions) { session in
                        DrawerRow(session: session, showsStatus: group.title == "Today",
                                  waiting: store.home.needsYou(session), current: session.id == store.openSession) {
                            store.open(session: session.id)
                        }
                    }
                }
                if store.loaded && groups.isEmpty {
                    Text(store.search.trimmed.isEmpty ? "No sessions yet. Start one with New session." : "No session matches “\(store.search.trimmed)”.")
                        .font(.system(size: 14)).foregroundStyle(EdenTheme.muted)
                        .padding(12)
                }
                if !store.home.exterminator.isEmpty && store.search.trimmed.isEmpty { exterminator }
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 20)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await store.refreshAll() }
    }

    private var exterminator: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Exterminator Mode")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(EdenTheme.chevron)
                .padding(EdgeInsets(top: 14, leading: 12, bottom: 4, trailing: 12))
                .accessibilityAddTraits(.isHeader)
            ForEach(store.home.exterminator) { run in
                Button { if let id = run.taskID { store.open(session: id) } } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(run.project).font(.system(size: 16)).foregroundStyle(EdenTheme.ink).lineLimit(1)
                        Text(run.line).font(.system(size: 13)).foregroundStyle(EdenTheme.muted).lineLimit(1)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Inbox and Queue

    private var shortcuts: some View {
        VStack(spacing: 0) {
            shortcut("Inbox", symbol: "tray", count: store.home.attention.count, tint: EdenTheme.orange) { store.show(.inbox) }
            shortcut("Queue", symbol: "list.bullet", count: store.todos.cards.filter(\.waiting).count, tint: EdenTheme.chevron) { store.show(.queue) }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private func shortcut(_ title: String, symbol: String, count: Int, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14, weight: .medium)).foregroundStyle(EdenTheme.muted).frame(width: 20)
                Text(title).font(.system(size: 15)).foregroundStyle(EdenTheme.ink)
                Spacer()
                if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(tint == EdenTheme.chevron ? EdenTheme.muted : .white)
                        .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                        .background(tint == EdenTheme.chevron ? EdenTheme.fill : tint, in: .capsule)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "\(title), \(count)" : title)
    }

    // MARK: - The Mac and Settings

    private var footer: some View {
        HStack(spacing: 10) {
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
                HStack(spacing: 10) {
                    EdenMarkTile(size: 32, mark: 16, radius: 16, line: 1.2)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(store.current?.macLabel ?? "Your Mac").font(.system(size: 15, weight: .medium)).foregroundStyle(EdenTheme.ink).lineLimit(1)
                        Text(connection.text).font(.system(size: 12)).foregroundStyle(connection.ink)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .accessibilityLabel("\(store.current?.macLabel ?? "Your Mac"), \(connection.text). Switch Mac")
            Button { store.show(.settings) } label: {
                GearGlyph()
                    .stroke(EdenTheme.ink, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 18, height: 18)
                    .frame(width: 36, height: 36)
                    .background(EdenTheme.fill.opacity(0.86), in: .circle)
            }
            .buttonStyle(PressScale(scale: 0.94))
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .overlay(alignment: .top) { Rectangle().fill(EdenTheme.divider).frame(height: 1) }
    }

    private var connection: (text: String, ink: Color) {
        if store.switchedOff { return ("Turned off on the Mac", EdenTheme.needsInk) }
        if store.problem != nil { return ("Can’t reach it", EdenTheme.needsInk) }
        if !store.loaded { return ("Connecting…", EdenTheme.chevron) }
        return ("Connected", EdenTheme.chevron)
    }

    // MARK: - The glass

    /// GDrawer's pane: white 38 % over a 40 pt blur, a bright right edge, a shadow to the right.
    private var pane: some View {
        Rectangle()
            .fill(dark ? Color(UIColor(hex: 0x1E2236, alpha: 0.55)) : Color.white.opacity(0.38))
            // The clear glass: the wallpaper shows through, as in the mockup.
            .glassEffect(.clear, in: .rect)
            .overlay(alignment: .trailing) {
                Rectangle().fill(Color.white.opacity(dark ? 0.10 : 0.7)).frame(width: 1)
            }
            .shadow(color: dark ? .black.opacity(0.5) : Color(UIColor(hex: 0x283C78, alpha: 0.18)), radius: 22, x: 16)
            .ignoresSafeArea()
    }

    private func topLine(_ radius: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(dark ? 0.12 : 1), location: 0), .init(color: .clear, location: 0.12)],
                                         startPoint: .top, endPoint: .bottom), lineWidth: 1)
            .allowsHitTesting(false)
    }
}

/// One session in the drawer: its name and (today) its one coloured word, the dot or spinner
/// at the end; the open one sits on a lighter glass.
struct DrawerRow: View {
    var session: PhoneSummary
    var showsStatus: Bool
    var waiting: Bool
    var current: Bool
    var action: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var status: CodeStatus { waiting ? .needsYou : session.status }
    private var word: String {
        GStatus.showsIndicator(status) ? GStatus.drawerWord(status) : GStatus.restingLine(session.updatedAt)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(session.title).font(.system(size: 16)).foregroundStyle(EdenTheme.ink).lineLimit(1)
                    if showsStatus {
                        Text(word).font(.system(size: 13)).foregroundStyle(GStatus.ink(status)).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if showsStatus && GStatus.showsIndicator(status) { indicator }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background {
                if current {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(scheme == .dark ? Color.white.opacity(0.12) : Color.white.opacity(0.55))
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(scheme == .dark ? 0.15 : 1), location: 0), .init(color: .clear, location: 0.1)],
                                                             startPoint: .top, endPoint: .bottom), lineWidth: 1)
                        }
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.title), \(word)")
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private var indicator: some View {
        if status == .working {
            Spinner(size: 14)
        } else {
            Circle().fill(EdenTheme.dot(status)).frame(width: 9, height: 9).accessibilityHidden(true)
        }
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
        .gGlass(RoundedRectangle(cornerRadius: 18, style: .continuous))
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
