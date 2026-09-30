import XCTest

/// Drives the iPhone app against a throwaway companion server, the way a person would:
/// type the address and code, ask, answer the approval, use the quick actions, unpair.
///
/// Skipped unless the server is given, e.g.
///     TEST_RUNNER_JARVIS_TEST_SERVER=127.0.0.1:8766 TEST_RUNNER_JARVIS_TEST_CODE=123456 \
///       xcodebuild test -scheme JarvisCompanion -destination 'platform=iOS Simulator,name=iPhone 17'
/// The server must answer "Email Pepper…" with a Send / Don't send approval (see README).
final class CompanionUITests: XCTestCase {
    private var server = ""
    private var code = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["JARVIS_TEST_SERVER"], let code = environment["JARVIS_TEST_CODE"] else {
            throw XCTSkip("No test server: set TEST_RUNNER_JARVIS_TEST_SERVER and TEST_RUNNER_JARVIS_TEST_CODE.")
        }
        self.server = server
        self.code = code
    }

    func testPairAskApproveQuickActionsAndUnpair() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-JARVISResetPairing", "YES", "-JARVISTestSpeak", "NO"]
        app.launch()

        // Pair by typing.
        let address = app.textFields["Mac address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText(server + "\n")  // Next: on to the code
        app.typeText(code)  // the sixth digit pairs
        let ask = app.textFields["Ask Jarvis"]
        XCTAssertTrue(ask.waitForExistence(timeout: 15), "didn't reach the home screen")
        snapshot("home")

        // Ask something that needs a yes, and give it.
        ask.tap()
        ask.typeText("Email Pepper that the board meeting moved to Thursday at 3")
        app.buttons["Send to Jarvis"].tap()
        let card = app.descendants(matching: .any)["Jarvis needs your OK"]
        XCTAssertTrue(card.waitForExistence(timeout: 15), "no approval card")
        let allow = card.buttons["Send"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        snapshot("approval")
        allow.tap()
        XCTAssertTrue(element(containing: "Pepper has the new time", in: app).waitForExistence(timeout: 15), "no reply")
        snapshot("reply")

        // Quick actions.
        app.buttons["Take notes"].tap()
        XCTAssertTrue(app.buttons["Stop notes"].waitForExistence(timeout: 10))
        app.buttons["Stop notes"].tap()
        XCTAssertTrue(app.buttons["Take notes"].waitForExistence(timeout: 10))

        app.buttons["Brief me"].tap()
        XCTAssertTrue(element(containing: "Two meetings left today", in: app).waitForExistence(timeout: 15), "no briefing")

        app.buttons["Routines"].tap()
        let routine = app.buttons["Run Wind down"]
        XCTAssertTrue(routine.waitForExistence(timeout: 5))
        snapshot("routines")
        routine.tap()
        XCTAssertTrue(element(containing: "Routine · Wind down", in: app).waitForExistence(timeout: 15))

        app.buttons["What’s next?"].tap()
        XCTAssertTrue(element(containing: "design review with Happy", in: app).waitForExistence(timeout: 15))
        app.buttons["Stop"].tap()

        // Settings, then unpair.
        app.buttons["Settings"].tap()
        let speak = app.switches["Speak replies"]
        XCTAssertTrue(speak.waitForExistence(timeout: 5))
        snapshot("settings")
        // Unpair sits at the foot of Settings, below the fold on most phones: scroll to it
        // as a person would.
        let unpair = app.buttons["Unpair this iPhone"]
        var swipes = 0
        while !(unpair.exists && unpair.isHittable) && swipes < 4 {
            app.swipeUp()
            swipes += 1
        }
        unpair.tap()
        app.buttons["Unpair"].tap()
        XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 10), "didn't go back to pairing")
    }

    private func element(containing text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
