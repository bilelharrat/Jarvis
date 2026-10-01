import CoreLocation
import EventKit
import SwiftUI

/// Today at a glance, from this iPhone and your Mac: what needs you, what's next, the
/// weather, reminders due, and what Jarvis is working on.
struct TodayView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool
    let open: (Destination) -> Void
    @State private var today = TodayData()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Space.m) {
                    if !model.visibleApprovals.isEmpty {
                        needsYou
                    }
                    weatherCard
                    calendarCard
                    if !today.reminders.isEmpty {
                        remindersCard
                    }
                    if model.pairing != nil {
                        macCard
                    }
                    briefButton
                }
                .padding(.horizontal, Space.m)
                .padding(.bottom, Space.l)
            }
            .background(SpaceBackground())
            .navigationTitle("Today")
            .navigationSubtitle(Date().formatted(.dateTime.weekday(.wide).month(.wide).day()))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .refreshable {
                await today.load(macWeather: model.remote?.weather)
                await model.refresh()
            }
            .task { await today.load(macWeather: model.remote?.weather) }
        }
    }

    // MARK: - Cards

    private var needsYou: some View {
        Button { open(.home) } label: {
            card(tint: .orange) {
                HStack(spacing: Space.s) {
                    Image(systemName: "hand.raised.fill")
                        .font(.title2)
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.visibleApprovals.count == 1 ? "Jarvis needs your OK" : "\(model.visibleApprovals.count) things need your OK")
                            .font(.headline)
                        Text(model.visibleApprovals.first?.question ?? "")
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(2)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(Palette.muted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var weatherCard: some View {
        if let weather = today.weather {
            card(header: "Weather", symbol: "cloud.sun") {
                HStack(alignment: .center, spacing: Space.m) {
                    Image(systemName: weather.symbol)
                        .symbolRenderingMode(.multicolor)
                        .font(.system(size: 44))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(weather.temp.map { "\(Int($0.rounded()))\(weather.unit)" } ?? "—")
                            .font(.system(size: 40, weight: .light))
                        Text(weather.summary.capitalizedFirst)
                            .foregroundStyle(Palette.ink2)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        if !weather.city.isEmpty { Text(weather.city).font(.subheadline.weight(.semibold)) }
                        if let high = weather.high, let low = weather.low {
                            Text("H:\(Int(high.rounded()))°  L:\(Int(low.rounded()))°")
                                .font(.subheadline)
                                .foregroundStyle(Palette.ink2)
                        }
                    }
                }
            }
        } else if today.needsLocation {
            card(header: "Weather", symbol: "cloud.sun") {
                Button("Show the Weather Where You Are") {
                    Task { await today.load(macWeather: nil, askLocation: true) }
                }
            }
        }
    }

    private var calendarCard: some View {
        card(header: "Up Next", symbol: "calendar") {
            if !today.events.isEmpty {
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(today.events.prefix(4), id: \.self) { event in
                        HStack(alignment: .top, spacing: Space.s) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color(cgColor: event.color))
                                .frame(width: 4)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.title).font(.body.weight(.medium))
                                Text(event.time)
                                    .font(.subheadline)
                                    .foregroundStyle(Palette.ink2)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if let next = model.remote?.nextEvent {
                VStack(alignment: .leading, spacing: 2) {
                    Text(next.title).font(.body.weight(.medium))
                    Text([next.date?.formatted(date: .omitted, time: .shortened), next.location.nilIfEmpty].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
            } else if today.calendarAccess == .notDetermined {
                Button("Show Your Calendar") { Task { await today.load(macWeather: model.remote?.weather, askCalendar: true) } }
            } else {
                Text("Nothing else today.")
                    .foregroundStyle(Palette.ink2)
            }
        }
    }

    private var remindersCard: some View {
        card(header: "Reminders", symbol: "checklist") {
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(today.reminders.prefix(5), id: \.self) { reminder in
                    Label(reminder, systemImage: "circle")
                        .foregroundStyle(Palette.ink)
                }
            }
        }
    }

    private var macCard: some View {
        card(header: model.pairing?.macLabel ?? "Your Mac", symbol: "desktopcomputer") {
            VStack(alignment: .leading, spacing: Space.s) {
                if model.isOffline {
                    Label("Can’t be reached right now", systemImage: "wifi.slash")
                        .foregroundStyle(Palette.ink2)
                } else {
                    let sessions = model.remote?.liveCodeSessions ?? []
                    let tasks = model.remote?.activeTasks ?? []
                    if let meeting = model.remote?.meeting {
                        Label("Taking notes: \(meeting)", systemImage: "record.circle")
                            .foregroundStyle(.red)
                    }
                    if !sessions.isEmpty {
                        Button { open(.code) } label: {
                            Label("Jarvis Code: \(sessions.count == 1 ? "1 session" : "\(sessions.count) sessions")", systemImage: "chevron.left.forwardslash.chevron.right")
                        }
                    }
                    ForEach(tasks.prefix(3)) { task in
                        Label(task.title.nilIfEmpty ?? task.label, systemImage: "gearshape.2")
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                    }
                    if let active = model.remote?.delegationsActive, active > 0 {
                        Button { open(.conversations) } label: {
                            Label("\(active) conversation\(active == 1 ? "" : "s") held for you", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    Button { open(.digest) } label: {
                        Label("What did I miss?", systemImage: "tray.full")
                    }
                    if model.remote?.meeting == nil, sessions.isEmpty, tasks.isEmpty {
                        Text(model.remote.map { "Connected · \($0.state.label)" } ?? "Connecting…")
                            .font(.subheadline)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
        }
    }

    private var briefButton: some View {
        Button {
            open(.home)
            Task { await model.run(.briefing) }
        } label: {
            Label("Brief Me", systemImage: "sparkles")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(PrimaryButtonStyle())
        .padding(.top, Space.xs)
    }

    private func card<Content: View>(header: String? = nil, symbol: String? = nil, tint: Color = .white, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let header {
                Label(header.uppercased(), systemImage: symbol ?? "circle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.muted)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.m)
        .glassCard(cornerRadius: 22, tint: tint)
    }
}

/// What Today shows from this iPhone.
@MainActor
@Observable
final class TodayData {
    struct Event: Hashable {
        var title: String
        var time: String
        var color: CGColor
    }

    var events: [Event] = []
    var reminders: [String] = []
    var weather: Weather?
    var needsLocation = false
    var calendarAccess: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .event)

    @ObservationIgnored private let store = EKEventStore()

    func load(macWeather: Weather?, askCalendar: Bool = false, askLocation: Bool = false) async {
        if askCalendar {
            _ = try? await store.requestFullAccessToEvents()
            _ = try? await store.requestFullAccessToReminders()
        }
        calendarAccess = EKEventStore.authorizationStatus(for: .event)
        if calendarAccess == .fullAccess { loadEvents() }
        if EKEventStore.authorizationStatus(for: .reminder) == .fullAccess { await loadReminders() }
        if let macWeather, macWeather.isAvailable {
            weather = macWeather
            needsLocation = false
        } else {
            await loadWeather(ask: askLocation)
        }
    }

    private func loadEvents() {
        let now = Date()
        let end = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now
        events = store.events(matching: store.predicateForEvents(withStart: now, end: end, calendars: nil))
            .filter { !$0.isAllDay || Calendar.current.isDateInToday($0.startDate) }
            .sorted { $0.startDate < $1.startDate }
            .map { event in
                Event(
                    title: event.title ?? "Event",
                    time: event.isAllDay ? "All day" : "\(event.startDate.formatted(date: .omitted, time: .shortened)) – \(event.endDate.formatted(date: .omitted, time: .shortened))\(event.location.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? "")",
                    color: event.calendar.cgColor
                )
            }
    }

    private func loadReminders() async {
        let end = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date()))
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: end, calendars: nil)
        let items: [EKReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
        reminders = items.compactMap(\.title)
    }

    private func loadWeather(ask: Bool) async {
        let status = CLLocationManager().authorizationStatus
        guard ask || status == .authorizedWhenInUse || status == .authorizedAlways else {
            needsLocation = true
            return
        }
        guard let here = try? await Locator().current() else { return }
        needsLocation = false
        weather = try? await OpenMeteo.current(latitude: here.coordinate.latitude, longitude: here.coordinate.longitude)
    }
}
