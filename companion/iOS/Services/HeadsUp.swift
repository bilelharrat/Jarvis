import CoreLocation
import EventKit
import Foundation
import MapKit
import UserNotifications

/// Something Jarvis noticed before being asked: when to leave, two things at once, a day
/// with no break, an early start, reminders slipping. Worked out on the iPhone from the
/// calendar, reminders and Maps (no model calls). Only what's worth an interruption (leaving
/// now, a clash about to happen) becomes a notification; the rest waits on Today.
struct HeadsUp: Identifiable, Equatable, Sendable {
    enum Urgency: Int, Comparable, Sendable {
        case fyi, soon, now
        static func < (a: Urgency, b: Urgency) -> Bool { a.rawValue < b.rawValue }
    }

    let id: String
    var title: String
    var detail: String
    var symbol: String
    var urgency: Urgency
    /// When it's worth interrupting the owner for it (nil: it waits on Today).
    var notifyAt: Date?
    /// For ordering: when it matters.
    var at: Date
}

/// The rules, on plain values (so they're testable without the calendar).
enum HeadsUpRules {
    struct Event: Equatable, Sendable {
        var id: String
        var title: String
        var start: Date
        var end: Date
        var location: String?
        var allDay = false
    }

    struct Reminder: Equatable, Sendable {
        var id: String
        var title: String
        var due: Date?
    }

    /// Minutes kept spare before leaving.
    static let buffer: TimeInterval = 5 * 60

    /// travel: seconds to each event's place from here, by event id (what Maps said).
    static func compute(events: [Event], reminders: [Reminder], travel: [String: TimeInterval], now: Date, calendar: Calendar = .current) -> [HeadsUp] {
        var found: [HeadsUp] = []
        let timed = events.filter { !$0.allDay }.sorted { $0.start < $1.start }
        let time = { (date: Date) in date.formatted(date: .omitted, time: .shortened) }

        // When to leave.
        for event in timed where event.start > now && event.start.timeIntervalSince(now) <= 3 * 3600 {
            guard let place = event.location?.trimmed.nilIfEmpty, let seconds = travel[event.id] else { continue }
            let leave = event.start.addingTimeInterval(-seconds - buffer)
            guard leave.timeIntervalSince(now) <= 3600 else { continue }  // not for a while yet
            let minutes = Int((seconds / 60).rounded())
            let late = leave <= now
            found.append(HeadsUp(
                id: "leave:\(event.id):\(Int(event.start.timeIntervalSince1970))",
                title: late ? "Leave now for \(event.title)" : "Leave by \(time(leave)) for \(event.title)",
                detail: "About \(minutes) min to \(place); it starts at \(time(event.start)).",
                symbol: "car.fill",
                urgency: leave.timeIntervalSince(now) <= 15 * 60 ? .now : .soon,
                notifyAt: max(leave.addingTimeInterval(-10 * 60), now),
                at: leave
            ))
        }

        // Two things at once.
        let ahead = timed.filter { $0.end > now && calendar.isDate($0.start, inSameDayAs: now) }
        for (index, first) in ahead.enumerated() {
            for second in ahead[(index + 1)...] where second.start < first.end && second.start >= first.start {
                let soon = second.start.timeIntervalSince(now) <= 2 * 3600
                found.append(HeadsUp(
                    id: "clash:\(first.id):\(second.id)",
                    title: "Two things at \(time(second.start))",
                    detail: "\(second.title) overlaps \(first.title).",
                    symbol: "exclamationmark.2",
                    urgency: soon ? .now : .soon,
                    notifyAt: soon ? now : nil,
                    at: second.start
                ))
            }
        }

        // A run with no break.
        var run: [Event] = []
        func closeRun() {
            if run.count >= 3, let first = run.first, let last = run.last {
                found.append(HeadsUp(
                    id: "busy:\(first.id)",
                    title: "Back to back from \(time(first.start)) to \(time(last.end))",
                    detail: "\(run.count) things with no break in between.",
                    symbol: "rectangle.stack.fill",
                    urgency: .fyi, notifyAt: nil, at: first.start
                ))
            }
            run = []
        }
        for event in ahead.filter({ $0.start >= now }) {
            if let last = run.last, event.start.timeIntervalSince(last.end) > 5 * 60 { closeRun() }
            run.append(event)
        }
        closeRun()

        // An early start tomorrow, said the evening before.
        if calendar.component(.hour, from: now) >= 18,
           let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           let first = timed.first(where: { calendar.isDate($0.start, inSameDayAs: tomorrow) }),
           calendar.component(.hour, from: first.start) < 9 {
            found.append(HeadsUp(
                id: "early:\(first.id)",
                title: "Tomorrow starts at \(time(first.start))",
                detail: first.title,
                symbol: "alarm.fill",
                urgency: .fyi, notifyAt: nil, at: first.start
            ))
        }

        // Reminders slipping.
        let overdue = reminders.filter { ($0.due ?? .distantFuture) < now }
        if !overdue.isEmpty {
            found.append(HeadsUp(
                id: "overdue:\(overdue.map(\.id).sorted().joined(separator: ","))",
                title: overdue.count == 1 ? "A reminder is overdue" : "\(overdue.count) reminders are overdue",
                detail: overdue.prefix(3).map(\.title).joined(separator: ", "),
                symbol: "checklist.unchecked",
                urgency: .soon, notifyAt: nil, at: now
            ))
        }
        let dueSoon = reminders.filter { guard let due = $0.due else { return false }; return due >= now && due.timeIntervalSince(now) <= 2 * 3600 }
        for reminder in dueSoon {
            found.append(HeadsUp(
                id: "due:\(reminder.id)",
                title: "Due at \(time(reminder.due ?? now))",
                detail: reminder.title,
                symbol: "checklist",
                urgency: .fyi, notifyAt: nil, at: reminder.due ?? now
            ))
        }

        return found.sorted { $0.urgency != $1.urgency ? $0.urgency > $1.urgency : $0.at < $1.at }
    }
}

/// Works the heads-ups out from the iPhone's own calendar, reminders and Maps, and schedules
/// the notifications that are worth one.
@MainActor
@Observable
final class HeadsUpCenter {
    static let shared = HeadsUpCenter()
    static let notifyKey = "headsup.notify"

    private(set) var items: [HeadsUp] = []
    @ObservationIgnored private let store = EKEventStore()
    @ObservationIgnored private let locator = Locator()
    /// Seconds to each event's place, kept so a refresh in the background can still say when to leave.
    private var travel: [String: TimeInterval] {
        get { (UserDefaults.standard.dictionary(forKey: "headsup.travel") as? [String: TimeInterval]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "headsup.travel") }
    }

    static var notifies: Bool { UserDefaults.standard.object(forKey: notifyKey) as? Bool ?? true }

    /// foreground: Maps may be asked how long the trips take (it needs the location).
    func refresh(foreground: Bool = true) async {
        guard !TestHost.isRunningUnitTests else { return }
        let now = Date()
        let events = loadEvents(now: now)
        let reminders = await loadReminders()
        if foreground { await measureTrips(events, now: now) }
        items = HeadsUpRules.compute(events: events, reminders: reminders, travel: travel, now: now)
        await schedule(items)
    }

    private func loadEvents(now: Date) -> [HeadsUpRules.Event] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return [] }
        let end = Calendar.current.date(byAdding: .day, value: 2, to: Calendar.current.startOfDay(for: now)) ?? now
        return store.events(matching: store.predicateForEvents(withStart: now.addingTimeInterval(-3600), end: end, calendars: nil))
            .filter { event in
                // Not ones the owner declined.
                let me = event.attendees?.first { $0.isCurrentUser }
                return me?.participantStatus != .declined && event.availability != .free
            }
            .map { HeadsUpRules.Event(id: $0.calendarItemIdentifier, title: $0.title ?? "Event", start: $0.startDate, end: $0.endDate, location: $0.location, allDay: $0.isAllDay) }
    }

    private func loadReminders() async -> [HeadsUpRules.Reminder] {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else { return [] }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: Date().addingTimeInterval(2 * 3600), calendars: nil)
        let found: [EKReminder] = await withCheckedContinuation { done in
            store.fetchReminders(matching: predicate) { done.resume(returning: $0 ?? []) }
        }
        return found.map { reminder in
            HeadsUpRules.Reminder(id: reminder.calendarItemIdentifier, title: reminder.title ?? "Reminder", due: reminder.dueDateComponents?.date)
        }
    }

    /// How long to each upcoming place, by car, from here (at most a few asks per refresh).
    private func measureTrips(_ events: [HeadsUpRules.Event], now: Date) async {
        let upcoming = events.filter { !$0.allDay && $0.start > now && $0.start.timeIntervalSince(now) <= 3 * 3600 && ($0.location?.trimmed.isEmpty == false) }
        guard !upcoming.isEmpty, CLLocationManager().authorizationStatus != .denied,
              let here = try? await locator.current() else { return }
        var known = travel.filter { key, _ in events.contains { $0.id == key } }  // forget past ones
        for event in upcoming.prefix(3) {
            guard let place = event.location else { continue }
            let search = MKLocalSearch.Request()
            search.naturalLanguageQuery = place
            search.region = MKCoordinateRegion(center: here.coordinate, latitudinalMeters: 80_000, longitudinalMeters: 80_000)
            guard let target = try? await MKLocalSearch(request: search).start().mapItems.first else { continue }
            let request = MKDirections.Request()
            request.source = MKMapItem.forCurrentLocation()
            request.destination = target
            request.departureDate = now
            request.transportType = .automobile
            if let eta = try? await MKDirections(request: request).calculateETA() {
                known[event.id] = eta.expectedTravelTime
            }
        }
        travel = known
    }

    /// Notifications for what's worth one, once each; ones no longer true are taken back.
    private func schedule(_ items: [HeadsUp]) async {
        let center = UNUserNotificationCenter.current()
        let wanted = Self.notifies ? items.filter { $0.notifyAt != nil } : []
        let ids = Set(wanted.map { "headsup.\($0.id)" })
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("headsup.") }
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { !ids.contains($0) })
        guard !wanted.isEmpty, await center.notificationSettings().authorizationStatus == .authorized else { return }
        var sent = Set(UserDefaults.standard.stringArray(forKey: "headsup.sent") ?? [])
        for item in wanted where !sent.contains(item.id) {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.detail
            content.sound = .default
            content.interruptionLevel = .active
            let delay = max(1, (item.notifyAt ?? Date()).timeIntervalSinceNow)
            let request = UNNotificationRequest(identifier: "headsup.\(item.id)", content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false))
            try? await center.add(request)
            sent.insert(item.id)
        }
        UserDefaults.standard.set(Array(sent.suffix(200)), forKey: "headsup.sent")
    }
}
