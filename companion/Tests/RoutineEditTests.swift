import XCTest
@testable import JarvisCompanion

/// The routine editor on the Mac's own /api/routines answer (Fixtures/routines.json): it
/// starts at the routine's real time, sends only what the owner changed, and never offers a
/// change the Mac would carry out by turning the routine into another kind.
final class RoutineEditTests: XCTestCase {
    private var routines: [String: RoutineItem] = [:]

    override func setUpWithError() throws {
        let fixture = try ContractFixtureTests.fixture("routines")
        let list = try JSONDecoder().decode(RoutineList.self, from: fixture.data)
        routines = Dictionary(uniqueKeysWithValues: list.items.map { ($0.name, $0) })
    }

    private func edit(_ name: String) throws -> RoutineEdit {
        RoutineEdit(try XCTUnwrap(routines[name], "no routine \(name) in the fixture"))
    }

    func testARoutineThatIsOffKeepsItsTimeWhenItsDaysChange() throws {
        // Off: the Mac gives no next run, only "Mondays, Fridays at 4 PM".
        let portfolio = try edit("Portfolio check")
        XCTAssertNil(portfolio.routine.nextRun)
        XCTAssertEqual(portfolio.startClock, "16:00")
        XCTAssertEqual(portfolio.startDays, [0, 4])
        XCTAssertTrue(portfolio.changes(clock: portfolio.startClock, days: portfolio.startDays).isEmpty)
        XCTAssertEqual(
            portfolio.changes(clock: portfolio.startClock, days: [0, 2, 4]),
            RoutineEdit.Change(time: nil, days: [0, 2, 4])  // its time stays 4 PM
        )
    }

    func testDayBasedRoutinesChangeTimeAndDays() throws {
        let brief = try edit("Morning brief")  // "weekdays at 7 AM"
        XCTAssertTrue(brief.editsTime)
        XCTAssertTrue(brief.editsDays)
        XCTAssertEqual(brief.startClock, "07:00")
        XCTAssertEqual(brief.startDays, [0, 1, 2, 3, 4])
        XCTAssertTrue(brief.changes(clock: "07:00", days: [0, 1, 2, 3, 4]).isEmpty)
        XCTAssertEqual(brief.changes(clock: "07:30", days: [0, 1, 2, 3, 4]), RoutineEdit.Change(time: "07:30", days: nil))
        let review = try edit("Weekly review")  // "Fridays at 4 PM"
        XCTAssertEqual(review.startDays, [4])
        XCTAssertEqual(review.changes(clock: "16:00", days: [4, 5]), RoutineEdit.Change(time: nil, days: [4, 5]))
    }

    func testAOneOffChangesItsTimeOnly() throws {
        let dentist = try edit("Dentist")  // "once, <date> at 9 AM"
        XCTAssertTrue(dentist.editsTime)
        XCTAssertFalse(dentist.editsDays)
        XCTAssertEqual(dentist.startClock, "09:00")
        XCTAssertNil(dentist.changes(clock: "09:00", days: [1]).days)
    }

    func testTriggeredAndRepeatingRoutinesAreChangedOnTheMac() throws {
        // Saving days would make the Mac turn these into weekly routines at midnight.
        for name in ["Welcome home", "Stretch"] {  // "when you get home", "every hour, 9 AM to 5 PM"
            let routine = try edit(name)
            XCTAssertFalse(routine.editsDays, name)
            XCTAssertFalse(routine.editsTime, name)
            XCTAssertTrue(routine.changes(clock: "07:00", days: [0]).isEmpty, name)
        }
    }

    func testTheTimeIsReadFromTheScheduleTheMacDescribes() {
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "weekdays at 7 AM"), "07:00")
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "Mondays, Fridays at 4:30 PM"), "16:30")
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "every day at 12 AM"), "00:00")
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "every day at 12 PM"), "12:00")
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "daily at 22:30"), "22:30")
        XCTAssertEqual(RoutineSchedule.timeOfDay(in: "monthly on the 1st at 9 AM"), "09:00")
        XCTAssertNil(RoutineSchedule.timeOfDay(in: "when you get home"))
    }
}
