import UserNotifications
import XCTest
@testable import JarvisCompanion

/// The Mac's notification categories and what their actions send.
final class NotificationTests: XCTestCase {
    private func approvalInfo(kind: String = "approval", at: Double = Date().timeIntervalSince1970, choices: [[String: String]]? = nil) -> [AnyHashable: Any] {
        [
            "aps": ["alert": ["title": "Jarvis needs your OK", "body": "Email Pepper about Thursday?"]],
            "jarvis": [
                "kind": kind, "id": "a1b2c3", "at": at,
                "choices": choices ?? [["id": "allow", "label": "Send"], ["id": "deny", "label": "Don't send"]],
            ] as [String: Any],
        ]
    }

    func testCategoriesAreTheContractsOwn() throws {
        let categories = Dictionary(uniqueKeysWithValues: NotificationSetup.categories().map { ($0.identifier, $0) })
        XCTAssertEqual(Set(categories.keys), ["JARVIS_APPROVAL", "JARVIS_CODE_APPROVAL", "JARVIS_HEADSUP"])

        let approval = try XCTUnwrap(categories["JARVIS_APPROVAL"])
        XCTAssertEqual(approval.actions.map(\.identifier), ["ALLOW", "DENY", "DENY_REASON"])
        XCTAssertEqual(approval.actions.map(\.title), ["Allow", "Not now", "No, because…"])
        XCTAssertTrue(approval.actions[0].options.contains(.authenticationRequired))  // a yes needs the owner
        XCTAssertTrue(approval.actions[1].options.contains(.destructive))
        XCTAssertFalse(approval.actions[1].options.contains(.authenticationRequired))  // a no never does
        XCTAssertTrue(approval.actions[2] is UNTextInputNotificationAction)
        XCTAssertFalse(approval.actions[2].options.contains(.foreground))  // answered without opening the app

        let code = try XCTUnwrap(categories["JARVIS_CODE_APPROVAL"])
        XCTAssertEqual(code.actions.map(\.identifier), ["ALLOW", "DENY", "DENY_REASON"])
        XCTAssertEqual(code.actions.map(\.title), ["Yes", "No", "No, because…"])

        XCTAssertTrue(try XCTUnwrap(categories["JARVIS_HEADSUP"]).actions.isEmpty)
    }

    func testActionsBecomeTheRightRequest() throws {
        let allow = try XCTUnwrap(NotificationActionHandler.request(actionIdentifier: "ALLOW", text: nil, userInfo: approvalInfo()))
        XCTAssertEqual(allow.id, "a1b2c3")
        XCTAssertEqual(allow.sent, .init(choice: "allow"))

        let deny = try XCTUnwrap(NotificationActionHandler.request(actionIdentifier: "DENY", text: nil, userInfo: approvalInfo()))
        XCTAssertEqual(deny.sent, .init(choice: "deny"))

        let reason = try XCTUnwrap(NotificationActionHandler.request(actionIdentifier: "DENY_REASON", text: " send it tomorrow ", userInfo: approvalInfo()))
        XCTAssertEqual(reason.sent, .init(choice: "deny", feedback: "send it tomorrow"))

        // A Jarvis Code plan card has no deny: its own no carries the reason.
        let plan = approvalInfo(kind: "code_approval", choices: [["id": "plan_edits", "label": "Go"], ["id": "plan_keep", "label": "Keep planning"]])
        let keep = try XCTUnwrap(NotificationActionHandler.request(actionIdentifier: "DENY_REASON", text: "split step two", userInfo: plan))
        XCTAssertEqual(keep.sent, .init(choice: "plan_keep", feedback: "split step two"))

        // Not answers: a tap, a heads-up, something that isn't the Mac's.
        XCTAssertNil(NotificationActionHandler.request(actionIdentifier: UNNotificationDefaultActionIdentifier, text: nil, userInfo: approvalInfo()))
        XCTAssertNil(NotificationActionHandler.request(actionIdentifier: "ALLOW", text: nil, userInfo: approvalInfo(kind: "headsup")))
        XCTAssertNil(NotificationActionHandler.request(actionIdentifier: "ALLOW", text: nil, userInfo: ["aps": ["alert": "hi"]]))
    }

    func testHandlingReportsWhatHappened() async {
        let sent = Recorder()
        let answered = await NotificationActionHandler.handle(actionIdentifier: "DENY_REASON", text: "not now", userInfo: approvalInfo()) { id, choice, feedback in
            await sent.record("\(id) \(choice) \(feedback ?? "-")")
            return true
        }
        XCTAssertEqual(answered, .answered)
        let requests = await sent.values
        XCTAssertEqual(requests, ["a1b2c3 deny not now"])

        let already = await NotificationActionHandler.handle(actionIdentifier: "ALLOW", text: nil, userInfo: approvalInfo()) { _, _, _ in false }
        XCTAssertEqual(already, .alreadyAnswered)

        let failed = await NotificationActionHandler.handle(actionIdentifier: "ALLOW", text: nil, userInfo: approvalInfo()) { _, _, _ in
            throw JarvisError.unreachable("down")
        }
        XCTAssertEqual(failed, .failed(.unreachable("down")))

        let unpaired = await NotificationActionHandler.handle(actionIdentifier: "ALLOW", text: nil, userInfo: approvalInfo(), approve: nil)
        XCTAssertEqual(unpaired, .notPaired)

        let tap = await NotificationActionHandler.handle(actionIdentifier: UNNotificationDefaultActionIdentifier, text: nil, userInfo: approvalInfo(), approve: nil)
        XCTAssertEqual(tap, .notAnAnswer)
    }

    func testAnAnswerThatDidntArriveComesBackWhileTheCardMayStillBeOpen() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let fresh = approvalInfo(at: now.timeIntervalSince1970 - 60)
        let push = try XCTUnwrap(JarvisPush(userInfo: fresh))
        let retry = try XCTUnwrap(NotificationActionHandler.retryContent(for: push, userInfo: fresh, now: now))
        XCTAssertEqual(retry.categoryIdentifier, "JARVIS_APPROVAL")
        XCTAssertEqual(retry.title, "Jarvis needs your OK")
        XCTAssertEqual(JarvisPush(userInfo: retry.userInfo)?.id, "a1b2c3")  // same actions, same card

        let code = approvalInfo(kind: "code_approval", at: now.timeIntervalSince1970 - 10)
        XCTAssertEqual(NotificationActionHandler.retryContent(for: try XCTUnwrap(JarvisPush(userInfo: code)), userInfo: code, now: now)?.categoryIdentifier, "JARVIS_CODE_APPROVAL")

        // The Mac gives up after five minutes: no point asking again.
        let stale = approvalInfo(at: now.timeIntervalSince1970 - 400)
        XCTAssertNil(NotificationActionHandler.retryContent(for: try XCTUnwrap(JarvisPush(userInfo: stale)), userInfo: stale, now: now))
        XCTAssertNil(NotificationActionHandler.retryContent(for: JarvisPush(kind: .headsup, id: "h"), userInfo: [:], now: now))
    }

    func testTokensGoToTheMacAsLowercaseHex() {
        XCTAssertEqual(PushToken.hex(Data([0x00, 0x0f, 0xab, 0xff])), "000fabff")
    }
}

private actor Recorder {
    private(set) var values: [String] = []

    func record(_ value: String) {
        values.append(value)
    }
}
