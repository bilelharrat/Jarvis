import XCTest
@testable import JarvisCompanion

/// How an answer (a button, a notification action, the Watch) becomes POST /api/approve.
final class ApprovalResponseTests: XCTestCase {
    private let email = [ApprovalChoice(id: "allow", label: "Send"), ApprovalChoice(id: "deny", label: "Don’t send")]
    private let tool = [ApprovalChoice(id: "allow", label: "Run"), ApprovalChoice(id: "always", label: "Always"), ApprovalChoice(id: "deny", label: "Not now")]
    private let plan = [
        ApprovalChoice(id: "plan_edits", label: "Go, auto-accept edits"),
        ApprovalChoice(id: "plan_ask", label: "Go, ask before edits"),
        ApprovalChoice(id: "plan_keep", label: "Keep planning"),
    ]
    private let purchase = [ApprovalChoice(id: "allow", label: "Confirm purchase"), ApprovalChoice(id: "deny", label: "Cancel")]

    func testAllowSendsTheFirstChoiceThatIsntANo() {
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: email), .init(choice: "allow"))
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: tool).choice, "allow")
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: purchase).choice, "allow")
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: plan).choice, "plan_edits")
        let noFirst = [ApprovalChoice(id: "no", label: "No"), ApprovalChoice(id: "yes", label: "Yes")]
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: noFirst).choice, "yes")
        XCTAssertEqual(ApprovalResponse.choice(for: .allow, choices: []).choice, "allow")  // choices unknown
    }

    func testDenySendsDenyOrTheCardsOwnNo() {
        XCTAssertEqual(ApprovalResponse.choice(for: .deny, choices: email), .init(choice: "deny"))
        XCTAssertEqual(ApprovalResponse.choice(for: .deny, choices: tool).choice, "deny")
        XCTAssertEqual(ApprovalResponse.choice(for: .deny, choices: []).choice, "deny")
        // A plan has no "deny": its no is the last choice, what the Mac picks when nobody answers.
        XCTAssertEqual(ApprovalResponse.choice(for: .deny, choices: plan).choice, "plan_keep")
        let reject = [ApprovalChoice(id: "go", label: "Go"), ApprovalChoice(id: "reject", label: "Reject"), ApprovalChoice(id: "later", label: "Later")]
        XCTAssertEqual(ApprovalResponse.choice(for: .deny, choices: reject).choice, "reject")
    }

    func testNoBecauseCarriesTheReasonTrimmedAndCapped() {
        let sent = ApprovalResponse.choice(for: .denyBecause("  send it to Happy instead  "), choices: email)
        XCTAssertEqual(sent, .init(choice: "deny", feedback: "send it to Happy instead"))
        let long = ApprovalResponse.choice(for: .denyBecause(String(repeating: "x", count: 2500)), choices: tool)
        XCTAssertEqual(long.feedback?.count, 2000)
        XCTAssertNil(ApprovalResponse.choice(for: .denyBecause("   "), choices: email).feedback)  // a plain no
        XCTAssertEqual(ApprovalResponse.choice(for: .denyBecause("split step two"), choices: plan), .init(choice: "plan_keep", feedback: "split step two"))
    }

    func testNotificationActionsMapToAnswers() {
        XCTAssertEqual(ApprovalResponse.answer(forAction: "ALLOW", text: nil), .allow)
        XCTAssertEqual(ApprovalResponse.answer(forAction: "DENY", text: "ignored"), .deny)
        XCTAssertEqual(ApprovalResponse.answer(forAction: "DENY_REASON", text: "not today"), .denyBecause("not today"))
        XCTAssertEqual(ApprovalResponse.answer(forAction: "DENY_REASON", text: nil), .denyBecause(""))
        XCTAssertNil(ApprovalResponse.answer(forAction: "com.apple.UNNotificationDefaultActionIdentifier", text: nil))
    }
}

final class DestinationTests: XCTestCase {
    func testRoundTripsThroughLinks() {
        let all: [Destination] = [.home, .code, .codeSession(42), .conversations, .routines, .digest, .spending, .showJarvis, .outbox]
        for destination in all {
            XCTAssertEqual(Destination(url: destination.url), destination, destination.url.absoluteString)
        }
        XCTAssertEqual(Destination.codeSession(42).url.absoluteString, "jarvis-companion://code/42")
    }

    func testRefusesOtherLinks() {
        XCTAssertNil(Destination(url: URL(string: "https://example.com/code")!))
        XCTAssertNil(Destination(url: URL(string: "jarvis-companion://code/abc")!))
        XCTAssertNil(Destination(url: URL(string: "jarvis-companion://settings/unpair")!))
        XCTAssertEqual(Destination(url: URL(string: "jarvis-companion://")!), .home)
    }

    func testPushesLeadToTheirPlace() {
        XCTAssertEqual(Destination(push: JarvisPush(kind: .codeNeedsYou, id: "a", taskID: 7)), .codeSession(7))
        XCTAssertEqual(Destination(push: JarvisPush(kind: .codeDone, id: "a")), .code)
        XCTAssertEqual(Destination(push: JarvisPush(kind: .codeApproval, id: "a", taskID: 3)), .codeSession(3))
        XCTAssertEqual(Destination(push: JarvisPush(kind: .delegation, id: "d1")), .conversations)
        XCTAssertEqual(Destination(push: JarvisPush(kind: .approval, id: "a")), .home)
        XCTAssertEqual(Destination(push: JarvisPush(kind: .headsup, id: "h")), .home)
    }
}
