import CoreLocation
import HealthKit
import UIKit
import XCTest
@testable import JarvisCompanion

/// Location, health and the camera: the arithmetic apart from the frameworks.
final class SensorTests: XCTestCase {
    private let night = Date(timeIntervalSince1970: 1_790_000_000)

    func testSleepCountsOverlapsOnce() throws {
        let hour: TimeInterval = 3600
        // The iPhone and the Watch both recorded the same night, with a gap at 3 am.
        let intervals = [
            (night, night.addingTimeInterval(3 * hour)),
            (night.addingTimeInterval(1 * hour), night.addingTimeInterval(4 * hour)),
            (night.addingTimeInterval(4.5 * hour), night.addingTimeInterval(7 * hour)),
            (night.addingTimeInterval(6 * hour), night.addingTimeInterval(6 * hour)),  // empty
        ]
        XCTAssertEqual(try XCTUnwrap(HealthMath.hours(merging: intervals)), 6.5, accuracy: 0.001)
        XCTAssertNil(HealthMath.hours(merging: []))
        XCTAssertEqual(try XCTUnwrap(HealthMath.hours(merging: [(night, night.addingTimeInterval(hour))])), 1, accuracy: 0.001)
    }

    func testOnlyAsleepStagesCount() {
        XCTAssertTrue(HealthMath.isAsleep(HKCategoryValueSleepAnalysis.asleepDeep.rawValue))
        XCTAssertTrue(HealthMath.isAsleep(HKCategoryValueSleepAnalysis.asleepREM.rawValue))
        XCTAssertTrue(HealthMath.isAsleep(HKCategoryValueSleepAnalysis.asleepCore.rawValue))
        XCTAssertFalse(HealthMath.isAsleep(HKCategoryValueSleepAnalysis.inBed.rawValue))
        XCTAssertFalse(HealthMath.isAsleep(HKCategoryValueSleepAnalysis.awake.rawValue))
    }

    func testWorkoutsHavePlainNames() {
        XCTAssertEqual(HealthMath.name(of: .running), "running")
        XCTAssertEqual(HealthMath.name(of: .traditionalStrengthTraining), "strength training")
        XCTAssertEqual(HealthMath.name(of: .curling), "workout")
    }

    func testAFixGoesWhenItsWorthIt() {
        let here = CLLocation(latitude: 34.0259, longitude: -118.7798)
        let now = night
        XCTAssertTrue(LocationService.worthSending(here, after: nil, now: now))
        XCTAssertFalse(LocationService.worthSending(here, after: (here, now.addingTimeInterval(-60)), now: now))
        XCTAssertTrue(LocationService.worthSending(here, after: (here, now.addingTimeInterval(-6 * 60)), now: now))
        let far = CLLocation(latitude: 34.0359, longitude: -118.7798)  // about 1.1 km north
        XCTAssertTrue(LocationService.worthSending(far, after: (here, now.addingTimeInterval(-60)), now: now))
    }

    func testAPhotoGoesAsASmallJPEG() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }()).image { context in
            UIColor.systemIndigo.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
        }
        let jpeg = try XCTUnwrap(PhotoPrep.jpeg(from: image))
        XCTAssertLessThanOrEqual(jpeg.count, PhotoPrep.maxBytes)
        let decoded = try XCTUnwrap(UIImage(data: jpeg))
        XCTAssertEqual(max(decoded.size.width * decoded.scale, decoded.size.height * decoded.scale), PhotoPrep.longest, accuracy: 1)
        XCTAssertEqual(jpeg.prefix(2), Data([0xFF, 0xD8]))  // JPEG
    }

    func testThePhotoAnswerIsTheMacsShape() throws {
        let later = try JSONDecoder().decode(AskResult.self, from: Data(#"{"reply": "", "done": false, "approvals": [{"id": "a", "question": "OK?"}]}"#.utf8))
        XCTAssertFalse(later.done)
        XCTAssertEqual(later.approvals.count, 1)
    }
}
