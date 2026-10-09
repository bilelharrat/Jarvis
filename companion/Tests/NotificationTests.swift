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
        // The iPhone also answers Eden's task approvals from askeden.com (tested below).
        XCTAssertEqual(Set(categories.keys), ["JARVIS_APPROVAL", "JARVIS_CODE_APPROVAL", "JARVIS_HEADSUP", "EDEN_TASK_APPROVAL"])

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

        // An Eden Code plan card has no deny: its own no carries the reason.
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

    // MARK: - Eden's tasks (askeden.com's pushes, site/src/accounts/tasks.js notifyOwner)

    private func edenInfo(kind: String = "approval", task: Any = "0123456789abcdef", approval: Any? = "fedcba9876543210", url: Any = "/#tasks") -> [AnyHashable: Any] {
        var eden: [String: Any] = ["url": url, "kind": kind, "task": task]
        if let approval { eden["approval"] = approval }
        return [
            "aps": [
                "alert": ["title": "Approve? Weekly digest", "body": "Send the digest to pepper@example.com"],
                "sound": "default", "thread-id": "eden-tasks", "category": "EDEN_TASK_APPROVAL",
            ] as [String: Any],
            "eden": eden,
        ]
    }

    func testEdenPushesAreReadAndTheirIDsChecked() throws {
        let approval = try XCTUnwrap(EdenTaskPush(userInfo: edenInfo()))
        XCTAssertEqual(approval.kind, .approval)
        XCTAssertEqual(approval.taskID, "0123456789abcdef")
        XCTAssertEqual(approval.approvalID, "fedcba9876543210")
        XCTAssertEqual(approval.page, "/#tasks")
        XCTAssertEqual(approval.title, "Approve? Weekly digest")
        XCTAssertEqual(approval.body, "Send the digest to pepper@example.com")
        XCTAssertTrue(approval.isApproval)

        let task = try XCTUnwrap(EdenTaskPush(userInfo: edenInfo(kind: "task", approval: nil)))
        XCTAssertEqual(task.kind, .task)
        XCTAssertEqual(task.taskID, "0123456789abcdef")
        XCTAssertNil(task.approvalID)
        XCTAssertFalse(task.isApproval)
        // A task push never answers an approval, whatever it carries.
        XCTAssertNil(EdenTaskPush(userInfo: edenInfo(kind: "task"))?.approvalID)
        XCTAssertEqual(EdenTaskPush(userInfo: edenInfo(kind: "later"))?.kind, .unknown)

        // Only 16 lowercase hex characters are ids.
        let badIDs: [Any] = ["FEDCBA9876543210", "fedcba987654321", "fedcba98765432100", "fedcba987654321g", "../../account/xx", " fedcba987654321", 1234567890123456]
        for bad in badIDs {
            let push = try XCTUnwrap(EdenTaskPush(userInfo: edenInfo(task: bad, approval: bad)))
            XCTAssertNil(push.approvalID, "\(bad)")
            XCTAssertNil(push.taskID, "\(bad)")
            XCTAssertFalse(push.isApproval, "\(bad)")
        }

        // Not Eden's: the Mac's pushes (which route exactly as before), and anything else.
        XCTAssertNil(EdenTaskPush(userInfo: approvalInfo()))
        XCTAssertNil(EdenTaskPush(userInfo: approvalInfo().merging(["eden": ["kind": "approval"]]) { a, _ in a }))
        XCTAssertNil(EdenTaskPush(userInfo: ["aps": ["alert": "hi"]]))
        XCTAssertNil(EdenTaskPush(userInfo: ["eden": "approval"]))
        XCTAssertNil(JarvisPush(userInfo: edenInfo()))
    }

    func testEdenOpensOnlyPagesOnItsOwnSite() throws {
        func opened(_ url: Any) throws -> String {
            try XCTUnwrap(EdenTaskPush(userInfo: edenInfo(url: url))).openURL(base: AccountClient.base).absoluteString
        }
        XCTAssertEqual(try opened("/#tasks"), "https://askeden.com/#tasks")
        XCTAssertEqual(try opened("/#tasks/0123456789abcdef"), "https://askeden.com/#tasks/0123456789abcdef")
        XCTAssertEqual(try opened("/settings?tab=tasks"), "https://askeden.com/settings?tab=tasks")
        XCTAssertEqual(try opened("/@evil.example"), "https://askeden.com/@evil.example")  // a path, still on askeden.com

        // Anything that isn't a plain path there opens Eden's Tasks.
        let badPages: [Any] = [
            "https://evil.example/#tasks", "http://askeden.com/#tasks", "//evil.example/#tasks", "/\\evil.example",
            "javascript:alert(1)", "#tasks", "tasks", "", " /#tasks", "/#tasks\n", 42,
        ]
        for bad in badPages {
            XCTAssertEqual(try opened(bad), "https://askeden.com/#tasks", "\(bad)")
        }
        var missing = edenInfo()
        missing["eden"] = ["kind": "task"]
        XCTAssertEqual(EdenTaskPush(userInfo: missing)?.openURL(base: AccountClient.base), URL(string: "https://askeden.com/#tasks"))

        // On the account's host, whatever it is.
        let local = try XCTUnwrap(EdenTaskPush(userInfo: edenInfo(url: "/#tasks")))
        XCTAssertEqual(local.openURL(base: URL(string: "http://localhost:8787/api")!).absoluteString, "http://localhost:8787/#tasks")
    }

    func testEdenCategoryApprovesOrDeniesWithoutOpeningAnything() throws {
        let categories = Dictionary(uniqueKeysWithValues: NotificationSetup.categories().map { ($0.identifier, $0) })
        let eden = try XCTUnwrap(categories["EDEN_TASK_APPROVAL"])
        XCTAssertEqual(eden.actions.map(\.identifier), ["EDEN_APPROVE", "EDEN_DENY"])
        XCTAssertEqual(eden.actions.map(\.title), ["Approve", "Deny"])
        XCTAssertTrue(eden.actions[0].options.contains(.authenticationRequired))  // a yes needs the owner
        XCTAssertFalse(eden.actions[0].options.contains(.foreground))
        XCTAssertTrue(eden.actions[1].options.contains(.destructive))
        XCTAssertFalse(eden.actions[1].options.contains(.authenticationRequired))  // a no never does
        XCTAssertFalse(eden.actions[1].options.contains(.foreground))
        XCTAssertEqual(eden.hiddenPreviewsBodyPlaceholder, "Eden needs your OK")

        XCTAssertEqual(EdenTaskActions.decision(forAction: "EDEN_APPROVE"), .approve)
        XCTAssertEqual(EdenTaskActions.decision(forAction: "EDEN_DENY"), .deny)
        for other in ["ALLOW", "DENY", "DENY_REASON", UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier, "eden_approve", ""] {
            XCTAssertNil(EdenTaskActions.decision(forAction: other), other)
        }
    }

    func testEdenDecisionsGoToAskedenAsTheContractSays() async throws {
        FakeTaskApprovals.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeTaskApprovals.self]
        let client = AccountClient(base: URL(string: "https://askeden.test/api")!, token: "jv1.test", session: URLSession(configuration: configuration))

        let approved = try await client.decideTaskApproval(id: "fedcba9876543210", approve: true)
        XCTAssertEqual(approved, .init(id: "fedcba9876543210", status: "approved", result: "Sent to pepper@example.com.", taskTitle: "Weekly digest"))
        var sent = try XCTUnwrap(FakeTaskApprovals.requests.last)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/tasks/approvals/fedcba9876543210")
        XCTAssertEqual(sent.authorization, "Bearer jv1.test")
        XCTAssertEqual(sent.contentType, "application/json")
        XCTAssertNil(sent.origin)
        XCTAssertEqual(sent.body, ["decision": "approve"])

        let denied = try await client.decideTaskApproval(id: "fedcba9876543210", approve: false)
        XCTAssertEqual(denied.status, "denied")
        sent = try XCTUnwrap(FakeTaskApprovals.requests.last)
        XCTAssertEqual(sent.body, ["decision": "deny"])

        // askeden.com's refusals come back as the client's errors, in its words.
        do {
            _ = try await client.decideTaskApproval(id: "0000000000000409", approve: true)
            XCTFail("a decided approval should be refused")
        } catch {
            XCTAssertEqual(error as? AccountError, .conflict("It was already approved."))
            XCTAssertEqual(EdenTaskActions.outcome(of: error), .failed("It was already approved.", retry: false))
        }

        // An id that isn't Eden's never makes a request.
        let before = FakeTaskApprovals.requests.count
        do {
            _ = try await client.decideTaskApproval(id: "../../account", approve: true)
            XCTFail("not an id")
        } catch {
            XCTAssertEqual(FakeTaskApprovals.requests.count, before)
        }
    }

    func testEdenAnswersThatDidntGoThroughSaySoAndComeBackWhenWorthIt() async throws {
        let info = edenInfo()
        let push = try XCTUnwrap(EdenTaskPush(userInfo: info))
        let sent = Recorder()
        let done = await EdenTaskActions.handle(actionIdentifier: "EDEN_DENY", push: push) { id, approve in
            await sent.record("\(id) \(approve)")
            return .init(id: id, status: "denied")
        }
        XCTAssertEqual(done, .done)
        let requests = await sent.values
        XCTAssertEqual(requests, ["fedcba9876543210 false"])

        // Approved, but sending went wrong: the server's words, no second try from here.
        let failed = await EdenTaskActions.handle(actionIdentifier: "EDEN_APPROVE", push: push) { id, _ in
            .init(id: id, status: "failed", error: "Gmail said the draft is gone.")
        }
        XCTAssertEqual(failed, .failed("Gmail said the draft is gone.", retry: false))

        let offline = await EdenTaskActions.handle(actionIdentifier: "EDEN_APPROVE", push: push) { _, _ in throw AccountError.network("offline") }
        XCTAssertEqual(offline, .failed("Couldn’t reach askeden.com. Try again, or open Eden’s Tasks to answer.", retry: true))
        guard case .failed(_, true)? = await EdenTaskActions.handle(actionIdentifier: "EDEN_APPROVE", push: push, decide: { _, _ in throw AccountError.server(502, nil) }) else {
            return XCTFail("a server problem is worth another try")
        }
        XCTAssertEqual(EdenTaskActions.outcome(of: AccountError.expired(nil)), .failed("That approval ran out.", retry: false))
        XCTAssertEqual(EdenTaskActions.outcome(of: AccountError.notFound("That approval is gone.")), .failed("That approval is gone.", retry: false))
        XCTAssertEqual(EdenTaskActions.outcome(of: AccountError.conflict(nil)), .failed("Already answered.", retry: false))

        let signedOut = await EdenTaskActions.handle(actionIdentifier: "EDEN_APPROVE", push: push, decide: nil)
        guard case .failed(_, false)? = signedOut else { return XCTFail("signed out: open Eden’s Tasks instead") }

        // Not answers: a tap, the Mac's actions.
        let tap = await EdenTaskActions.handle(actionIdentifier: UNNotificationDefaultActionIdentifier, push: push, decide: nil)
        XCTAssertNil(tap)
        let allow = await EdenTaskActions.handle(actionIdentifier: "ALLOW", push: push, decide: nil)
        XCTAssertNil(allow)

        // What comes back: the same push (a tap still opens Eden's Tasks), with Approve and Deny
        // again only when worth it.
        let retry = EdenTaskActions.followUp(for: push, words: "Couldn’t reach askeden.com.", retry: true, userInfo: info)
        XCTAssertEqual(retry.categoryIdentifier, "EDEN_TASK_APPROVAL")
        XCTAssertEqual(retry.title, "Approve? Weekly digest")
        XCTAssertEqual(retry.body, "Couldn’t reach askeden.com.")
        XCTAssertEqual(retry.threadIdentifier, "eden-tasks")
        XCTAssertEqual(EdenTaskPush(userInfo: retry.userInfo), push)
        let final = EdenTaskActions.followUp(for: push, words: "Already answered.", retry: false, userInfo: info)
        XCTAssertEqual(final.categoryIdentifier, "")
        XCTAssertEqual(EdenTaskPush(userInfo: final.userInfo)?.approvalID, "fedcba9876543210")
    }
}

/// askeden.com's POST /api/tasks/approvals/<id> (the GAPS-A Worker contract), recording what
/// it was sent: an id ending in 409 was decided already; anything else is decided now.
final class FakeTaskApprovals: URLProtocol, @unchecked Sendable {
    struct Sent: Sendable {
        var method: String
        var path: String
        var authorization: String?
        var contentType: String?
        var origin: String?
        var body: JSONValue?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var sent: [Sent] = []

    static func reset() { lock.withLock { sent = [] } }
    static var requests: [Sent] { lock.withLock { sent } }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "askeden.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let body = requestBody
        let path = request.url?.path ?? ""
        Self.lock.withLock {
            Self.sent.append(Sent(
                method: request.httpMethod ?? "GET", path: path,
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                contentType: request.value(forHTTPHeaderField: "Content-Type"),
                origin: request.value(forHTTPHeaderField: "Origin"), body: body
            ))
        }
        let id = String(path.split(separator: "/").last ?? "")
        let status: Int
        let reply: JSONValue
        if id.hasSuffix("409") {
            status = 409
            reply = ["error": "It was already approved.", "code": "conflict"]
        } else {
            status = 200
            let decided = body?["decision"]?.stringValue == "approve" ? "approved" : "denied"
            reply = ["approval": [
                "id": .string(id), "status": .string(decided), "task": "0123456789abcdef", "task_title": "Weekly digest",
                "result": decided == "approved" ? .string("Sent to pepper@example.com.") : .null, "error": .null,
            ]]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? reply.encoded()) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    private var requestBody: JSONValue? {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            var collected = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                collected.append(buffer, count: count)
            }
            stream.close()
            data = collected
        }
        return data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }
}

private actor Recorder {
    private(set) var values: [String] = []

    func record(_ value: String) {
        values.append(value)
    }
}
