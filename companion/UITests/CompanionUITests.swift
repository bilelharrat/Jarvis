import XCTest

/// Drives the iPhone app against a throwaway companion server (TLS, a self-signed
/// certificate), the way a person would: type the address and code, compare the
/// fingerprint and pair, ask, answer the approval, use the quick actions, unpair.
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

        // From the welcome, pair by typing.
        let pairWithMac = app.buttons["Pair with Your Mac"]
        XCTAssertTrue(pairWithMac.waitForExistence(timeout: 10), "no welcome")
        pairWithMac.tap()
        let address = app.textFields["Mac address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText(server + "\n")  // Next: on to the code
        app.typeText(code)
        // Typed by hand, pairing waits for a tap, with the Mac's fingerprint shown to compare.
        XCTAssertTrue(element(containing: "Mac’s fingerprint", in: app).waitForExistence(timeout: 15), "no fingerprint")
        if !app.buttons["Pair with Mac"].isHittable { app.swipeUp() }
        app.buttons["Pair with Mac"].tap()
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

        // The usual things, from the composer's + menu.
        quick("Take Meeting Notes", in: app)
        XCTAssertTrue(waitForMenuItem("Stop Meeting Notes", in: app), "notes didn't start")
        app.buttons["Stop Meeting Notes"].tap()
        XCTAssertTrue(waitForMenuItem("Take Meeting Notes", in: app), "notes didn't stop")
        dismissMenu(app)

        quick("Brief Me", in: app)
        XCTAssertTrue(element(containing: "Two meetings left today", in: app).waitForExistence(timeout: 15), "no briefing")

        quick("Routines", in: app)
        let routine = app.buttons["Run Wind down"]
        XCTAssertTrue(routine.waitForExistence(timeout: 5))
        snapshot("routines")
        routine.tap()
        app.buttons["Done"].tap()
        XCTAssertTrue(element(containing: "Routine · Wind down", in: app).waitForExistence(timeout: 15))

        quick("What’s Next?", in: app)
        XCTAssertTrue(element(containing: "design review with Happy", in: app).waitForExistence(timeout: 15))
        if app.buttons["Stop"].exists { app.buttons["Stop"].tap() }

        // Settings, then unpair.
        app.buttons["More"].tap()
        app.buttons["Settings"].tap()
        let speak = app.switches["Speak Replies"]
        XCTAssertTrue(speak.waitForExistence(timeout: 5))
        snapshot("settings")
        // Unpair sits at the foot of Settings, below the fold on most phones: scroll to it
        // as a person would.
        let unpair = app.buttons["Unpair This iPhone"]
        var swipes = 0
        while !(unpair.exists && unpair.isHittable) && swipes < 4 {
            app.swipeUp()
            swipes += 1
        }
        unpair.tap()
        app.buttons["Unpair"].tap()
        XCTAssertTrue(app.buttons["Pair with Your Mac"].waitForExistence(timeout: 10), "didn't go back to the welcome")
    }

    /// Opens the composer's + menu and picks an item.
    private func quick(_ item: String, in app: XCUIApplication) {
        app.buttons["More actions"].tap()
        let button = app.buttons[item]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no \(item) in the + menu")
        button.tap()
    }

    /// Opens the + menu and waits for an item to be offered.
    private func waitForMenuItem(_ item: String, in app: XCUIApplication) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            app.buttons["More actions"].tap()
            if app.buttons[item].waitForExistence(timeout: 1.5) { return true }
            dismissMenu(app)
        }
        return false
    }

    private func dismissMenu(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
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
