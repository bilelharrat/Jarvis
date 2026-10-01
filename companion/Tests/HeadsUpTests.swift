import XCTest
@testable import JarvisCompanion

/// What Jarvis notices before being asked, and what it interrupts for.
final class HeadsUpTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }()

    private func at(_ hour: Int, _ minute: Int = 0, day: Int = 1) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    private func event(_ id: String, _ title: String, _ start: Date, minutes: Double = 60, location: String? = nil) -> HeadsUpRules.Event {
        HeadsUpRules.Event(id: id, title: title, start: start, end: start.addingTimeInterval(minutes * 60), location: location)
    }

    func testItSaysWhenToLeaveAndInterruptsOnlyWhenItsTime() {
        let dentist = event("d", "Dentist", at(15), location: "12 Main St")
        let soon = HeadsUpRules.compute(events: [dentist], reminders: [], travel: ["d": 25 * 60], now: at(14, 25), calendar: calendar)
        XCTAssertEqual(soon.first?.urgency, .now)  // leave by 2:30: five minutes away
        XCTAssertTrue(soon.first?.title.hasPrefix("Leave by") == true)
        XCTAssertEqual(soon.first?.notifyAt, at(14, 25))  // ten minutes before leaving is already past: now

        let early = HeadsUpRules.compute(events: [dentist], reminders: [], travel: ["d": 25 * 60], now: at(13, 45), calendar: calendar)
        XCTAssertEqual(early.first?.urgency, .soon)
        XCTAssertEqual(early.first?.notifyAt, at(14, 20))  // the notification waits for its moment

        let late = HeadsUpRules.compute(events: [dentist], reminders: [], travel: ["d": 25 * 60], now: at(14, 40), calendar: calendar)
        XCTAssertTrue(late.first?.title.hasPrefix("Leave now") == true)

        XCTAssertTrue(HeadsUpRules.compute(events: [dentist], reminders: [], travel: ["d": 25 * 60], now: at(11), calendar: calendar).isEmpty)  // hours away
        XCTAssertTrue(HeadsUpRules.compute(events: [dentist], reminders: [], travel: [:], now: at(14, 25), calendar: calendar).isEmpty)  // Maps didn't say
    }

    func testTwoThingsAtOnceAreFlaggedAndInterruptWhenClose() {
        let review = event("r", "Design review", at(15), minutes: 60)
        let oneOnOne = event("o", "1:1 with Sam", at(15, 30), minutes: 30)
        let near = HeadsUpRules.compute(events: [review, oneOnOne], reminders: [], travel: [:], now: at(14), calendar: calendar)
        let clash = near.first { $0.id.hasPrefix("clash:") }
        XCTAssertEqual(clash?.detail, "1:1 with Sam overlaps Design review.")
        XCTAssertEqual(clash?.urgency, .now)
        XCTAssertNotNil(clash?.notifyAt)
        let far = HeadsUpRules.compute(events: [review, oneOnOne], reminders: [], travel: [:], now: at(9), calendar: calendar)
        XCTAssertEqual(far.first { $0.id.hasPrefix("clash:") }?.urgency, .soon)
        XCTAssertNil(far.first { $0.id.hasPrefix("clash:") }?.notifyAt)  // hours away: Today only
    }

    func testABusyRunAnEarlyStartAndSlippingReminders() {
        let run = [event("a", "A", at(13)), event("b", "B", at(14)), event("c", "C", at(15, 3))]
        let busy = HeadsUpRules.compute(events: run, reminders: [], travel: [:], now: at(12), calendar: calendar)
        XCTAssertEqual(busy.first { $0.id.hasPrefix("busy:") }?.detail, "3 things with no break in between.")
        XCTAssertNil(busy.first { $0.id.hasPrefix("busy:") }?.notifyAt)

        let flight = event("f", "Flight to Austin", at(7, 10, day: 2))
        let evening = HeadsUpRules.compute(events: [flight], reminders: [], travel: [:], now: at(20), calendar: calendar)
        XCTAssertEqual(evening.first?.detail, "Flight to Austin")
        XCTAssertTrue(evening.first?.title.hasPrefix("Tomorrow starts at") == true)
        XCTAssertTrue(HeadsUpRules.compute(events: [flight], reminders: [], travel: [:], now: at(10), calendar: calendar).isEmpty)  // only the evening before

        let reminders = [
            HeadsUpRules.Reminder(id: "1", title: "Pay rent", due: at(9)),
            HeadsUpRules.Reminder(id: "2", title: "Call Pepper", due: at(13)),
            HeadsUpRules.Reminder(id: "3", title: "Someday", due: nil),
        ]
        let slipping = HeadsUpRules.compute(events: [], reminders: reminders, travel: [:], now: at(12), calendar: calendar)
        XCTAssertEqual(slipping.map(\.detail), ["Pay rent", "Call Pepper"])
        XCTAssertEqual(slipping.first?.title, "A reminder is overdue")
        XCTAssertTrue(slipping.last?.title.hasPrefix("Due at ") == true)
        XCTAssertTrue(slipping.allSatisfy { $0.notifyAt == nil })  // Reminders alerts for these itself
    }

    func testTheMostUrgentComesFirst() {
        let items = HeadsUpRules.compute(
            events: [event("d", "Dentist", at(15), location: "12 Main St"), event("x", "Standup", at(15, 30), minutes: 15)],
            reminders: [HeadsUpRules.Reminder(id: "1", title: "Pay rent", due: at(9))],
            travel: ["d": 25 * 60], now: at(14, 25), calendar: calendar
        )
        XCTAssertEqual(items.first?.urgency, .now)
        XCTAssertEqual(items.map(\.urgency), items.map(\.urgency).sorted(by: >))
    }

    func testOnlyTheOwnerOnceTheLockIsOn() {
        XCTAssertTrue(OwnerLock.allows(on: false, unlocked: false))
        XCTAssertTrue(OwnerLock.allows(on: true, unlocked: true))
        XCTAssertFalse(OwnerLock.allows(on: true, unlocked: false))
    }
}
