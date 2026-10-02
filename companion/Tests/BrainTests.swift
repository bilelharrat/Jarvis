import FoundationModels
import XCTest
@testable import JarvisCompanion

/// Jarvis on the iPhone: the streamed answer rebuilt block by block, the wake word, dates the
/// tools read, the new places in the app, and the Mac's feature list.
final class BrainTests: XCTestCase {
    private func event(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testStreamRebuildsTextThinkingAndToolUse() throws {
        var stream = StreamAssembler()
        let events = [
            #"{"type":"message_start","message":{"id":"m"}}"#,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm"}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking "}}"#,
            #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"now."}}"#,
            #"{"type":"content_block_stop","index":1}"#,
            #"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"weather","input":{}}}"#,
            #"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"place\":"}}"#,
            #"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"Paris\"}"}}"#,
            #"{"type":"content_block_stop","index":2}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ]
        var textChanges = 0
        for json in events where try stream.take(event(json)) { textChanges += 1 }

        XCTAssertEqual(textChanges, 2)
        XCTAssertEqual(stream.text, "Checking now.")
        XCTAssertEqual(stream.stopReason, "tool_use")
        XCTAssertEqual(stream.blocks.count, 3)
        XCTAssertEqual(stream.blocks[0]["thinking"]?.stringValue, "Hmm")
        XCTAssertEqual(stream.blocks[0]["signature"]?.stringValue, "sig")
        XCTAssertEqual(stream.blocks[2]["input"]?["place"]?.stringValue, "Paris")
        XCTAssertNil(stream.blocks[2]["_invalid_input"])
    }

    func testStreamMarksUnreadableToolInputAndStripsTheMarkForTheAPI() throws {
        var stream = StreamAssembler()
        _ = try stream.take(event(#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"music","input":{}}}"#))
        _ = try stream.take(event(#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"action\":\"pl"}}"#))
        _ = try stream.take(event(#"{"type":"content_block_stop","index":0}"#))
        XCTAssertEqual(stream.blocks[0]["_invalid_input"]?.boolValue, true)
        XCTAssertNil(stream.blocks[0].forAPI["_invalid_input"])
        XCTAssertEqual(stream.blocks[0].forAPI["input"], .object([:]))
    }

    func testClaudeErrorsReadAsSomethingToDo() {
        XCTAssertEqual(ClaudeClient.failure(status: 401, body: Data()), .badKey)
        XCTAssertEqual(ClaudeClient.failure(status: 429, body: Data()), .rateLimited)
        XCTAssertEqual(ClaudeClient.failure(status: 529, body: Data()), .overloaded)
        let body = Data(#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#.utf8)
        XCTAssertEqual(ClaudeClient.failure(status: 400, body: body), .server(400, "bad"))
    }

    func testWakeWordFindsTheNameAndWhatFollows() {
        XCTAssertEqual(WakeWordListener.afterName(in: "Hey Jarvis"), "")
        XCTAssertEqual(WakeWordListener.afterName(in: "hey jarvis, what's next today?"), "what's next today")
        XCTAssertEqual(WakeWordListener.afterName(in: "OK Jervis turn on the lights"), "turn on the lights")
        XCTAssertNil(WakeWordListener.afterName(in: "what's the weather like"))
    }

    func testToolDatesReadTheWaysClaudeWritesThem() throws {
        let calendar = Calendar.current
        let moment = try XCTUnwrap(PhoneTools.moment("2026-10-01T09:30"))
        XCTAssertEqual(calendar.component(.hour, from: moment), 9)
        XCTAssertEqual(calendar.component(.minute, from: moment), 30)
        XCTAssertNotNil(PhoneTools.moment("2026-10-01 09:30"))
        XCTAssertNotNil(PhoneTools.day("2026-10-01"))
        XCTAssertNil(PhoneTools.moment("next Tuesday"))
    }

    func testWeatherCodesInWords() {
        XCTAssertEqual(OpenMeteo.describe(0), "clear")
        XCTAssertEqual(OpenMeteo.describe(63), "rain")
        XCTAssertEqual(OpenMeteo.describe(nil), "unknown conditions")
    }

    func testNewPlacesRoundTripAsLinks() {
        for place: Destination in [.phoneMemory, .heyJarvis, .mac(.markets), .mac(.meetings)] {
            XCTAssertEqual(Destination(url: place.url), place)
        }
        XCTAssertNil(Destination(url: URL(string: "jarvis-companion://mac/nonsense")!))
    }

    func testStateReadsTheMacsFeatures() throws {
        let json = Data(#"{"state":"idle","features":["memory","markets","prefs"]}"#.utf8)
        let state = try JSONDecoder().decode(RemoteState.self, from: json)
        XCTAssertEqual(state.features, ["memory", "markets", "prefs"])
        let older = try JSONDecoder().decode(RemoteState.self, from: Data(#"{"state":"idle"}"#.utf8))
        XCTAssertEqual(older.features, [])
    }

    @MainActor
    func testEveryToolHasASchemaClaudeAccepts() {
        let tools = PhoneTools()
        let definitions = tools.definitions()
        let names = definitions.compactMap { $0["name"]?.stringValue }
        XCTAssertEqual(Set(names).count, names.count, "tool names must be unique")
        XCTAssertFalse(names.contains("ask_mac"), "no Mac, no ask_mac")
        for tool in definitions where tool["type"] == nil {
            XCTAssertEqual(tool["input_schema"]?["type"]?.stringValue, "object")
            XCTAssertNotNil(tool["description"]?.stringValue)
        }
    }

    func testTheHostedVoiceGetsWholeSentencesUnderItsLimit() {
        let sentence = "The suit is ready, and the jet is fuelled. "
        let text = String(repeating: sentence, count: 40)
        let pieces = JarvisVoice.pieces(of: text)
        XCTAssertGreaterThan(pieces.count, 1)
        XCTAssertTrue(pieces.allSatisfy { $0.count <= JarvisVoice.hostedLimit })
        XCTAssertTrue(pieces.allSatisfy { $0.hasSuffix(".") }, "cut between sentences")
        XCTAssertEqual(pieces.joined(separator: " ").count, text.trimmingCharacters(in: .whitespaces).count)
        let long = String(repeating: "a", count: 1500)
        XCTAssertTrue(JarvisVoice.pieces(of: long).allSatisfy { $0.count <= JarvisVoice.hostedLimit })
    }

    func testTheInstallIDIsWhatAskedenTakes() {
        let id = JarvisVoice.installID
        XCTAssertEqual(id.count, 32)
        XCTAssertTrue(id.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertEqual(JarvisVoice.installID, id, "made once")
    }
}

/// Gemini speaking the conversation the brain keeps in Claude's blocks, and the fallback from
/// one service to the other.
final class GeminiTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testClaudesTurnsGoToGeminiAsPartsWithTheirToolResults() throws {
        let messages: [JSONValue] = [
            ["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": "AAA="]],
                ["type": "text", "text": "Weather where this is?"],
            ]],
            ["role": "assistant", "content": [
                ["type": "thinking", "thinking": "hmm", "signature": "s"],
                ["type": "text", "text": "Checking."],
                ["type": "tool_use", "id": "toolu_1", "name": "weather", "input": ["place": "Paris"]],
            ]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "toolu_1", "content": "18°, clear", "is_error": false]]],
        ]
        let contents = GeminiClient.contents(messages)
        XCTAssertEqual(contents.count, 3)
        XCTAssertEqual(contents[0]["parts"]?.arrayValue?[0]["inlineData"]?["mimeType"]?.stringValue, "image/jpeg")
        let model = try XCTUnwrap(contents[1]["parts"]?.arrayValue)
        XCTAssertEqual(contents[1]["role"]?.stringValue, "model")
        XCTAssertEqual(model.count, 2)  // the thinking stays Claude's
        XCTAssertEqual(model[1]["functionCall"]?["args"]?["place"]?.stringValue, "Paris")
        XCTAssertEqual(model[1]["thoughtSignature"]?.stringValue, GeminiClient.unsignedCall)
        let result = try XCTUnwrap(contents[2]["parts"]?.arrayValue?.first?["functionResponse"])
        XCTAssertEqual(result["name"]?.stringValue, "weather")
        XCTAssertEqual(result["response"]?["result"]?.stringValue, "18°, clear")
        XCTAssertNil(result["id"])  // Claude's id means nothing to Gemini
    }

    func testGeminisOwnTurnGoesBackExactlyAsItCame() throws {
        var stream = GeminiStream()
        XCTAssertTrue(stream.take(try json(#"{"candidates":[{"content":{"role":"model","parts":[{"text":"Let me "}]}}]}"#)))
        XCTAssertTrue(stream.take(try json(#"{"candidates":[{"content":{"role":"model","parts":[{"text":"check."}]}}]}"#)))
        XCTAssertFalse(stream.take(try json(#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc_9","name":"calendar_events","args":{"days":2}},"thoughtSignature":"SIG"}]},"finishReason":"STOP"}]}"#)))
        XCTAssertEqual(stream.text, "Let me check.")
        let response = try XCTUnwrap(stream.response)
        XCTAssertEqual(response.stopReason, "tool_use")
        XCTAssertEqual(response.text, "Let me check.")
        let call = try XCTUnwrap(response.content.first { $0["type"]?.stringValue == "tool_use" })
        XCTAssertEqual(call["id"]?.stringValue, "fc_9")
        XCTAssertEqual(call["input"]?["days"], .int(2))

        let messages: [JSONValue] = [
            ["role": "user", "content": [["type": "text", "text": "What's on?"]]],
            ["role": "assistant", "content": .array(response.content)],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "fc_9", "content": "Standup at 10"]]],
        ]
        let contents = GeminiClient.contents(messages)
        XCTAssertEqual(contents[1]["parts"]?.arrayValue, stream.parts)  // signature and all
        XCTAssertEqual(contents[1]["parts"]?.arrayValue?.count, 2)  // the pieces of text as one part
        XCTAssertEqual(contents[2]["parts"]?.arrayValue?.first?["functionResponse"]?["id"]?.stringValue, "fc_9")

        // And Claude, later in the same conversation, never sees Gemini's record of it.
        let forClaude = messages[1].forClaude["content"]?.arrayValue ?? []
        XCTAssertEqual(forClaude.compactMap { $0["type"]?.stringValue }, ["text", "tool_use"])
        XCTAssertNil(forClaude[1]["_gemini_id"])
    }

    func testTheWebToolsBecomeGooglesOwnAndEmptySchemasAreLeftOut() throws {
        let tools: [JSONValue] = [
            ["name": "timers", "description": "Lists timers.", "input_schema": ["type": "object", "properties": [:]]],
            ["name": "weather", "description": "Weather.", "input_schema": ["type": "object", "properties": ["place": ["type": "string"]]]],
            ["type": "web_search_20260209", "name": "web_search", "max_uses": 5],
            ["type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 3],
        ]
        let declared = GeminiClient.tools(tools, builtIns: true)
        XCTAssertEqual(declared.count, 3)
        let functions = try XCTUnwrap(declared[0]["functionDeclarations"]?.arrayValue)
        XCTAssertNil(functions[0]["parametersJsonSchema"])
        XCTAssertEqual(functions[1]["parametersJsonSchema"]?["properties"]?["place"]?["type"]?.stringValue, "string")
        XCTAssertNotNil(declared[1]["googleSearch"])
        XCTAssertNotNil(declared[2]["urlContext"])
        XCTAssertEqual(GeminiClient.tools(tools, builtIns: false).count, 1)

        let body = GeminiClient.body(system: "Be brief.", messages: [], tools: tools, builtIns: true, thinkingLevel: "LOW")
        XCTAssertEqual(body["toolConfig"]?["includeServerSideToolInvocations"], .bool(true))
        XCTAssertEqual(body["generationConfig"]?["thinkingConfig"]?["thinkingLevel"]?.stringValue, "LOW")
        XCTAssertEqual(body["systemInstruction"]?["parts"]?.arrayValue?.first?["text"]?.stringValue, "Be brief.")
    }

    func testGeminiStopsAndErrorsReadAsSomethingToDo() throws {
        var blocked = GeminiStream()
        _ = blocked.take(try json(#"{"promptFeedback":{"blockReason":"SAFETY"}}"#))
        XCTAssertEqual(blocked.response?.stopReason, "refusal")
        var long = GeminiStream()
        _ = long.take(try json(#"{"candidates":[{"content":{"parts":[{"text":"…"}]},"finishReason":"MAX_TOKENS"}]}"#))
        XCTAssertEqual(long.response?.stopReason, "max_tokens")
        XCTAssertNil(GeminiStream().response)

        XCTAssertEqual(GeminiClient.failure(status: 403, body: Data()), .badKey)
        XCTAssertEqual(GeminiClient.failure(status: 400, body: Data(#"{"error":{"message":"API key not valid.","status":"INVALID_ARGUMENT"}}"#.utf8)), .badKey)
        XCTAssertEqual(GeminiClient.failure(status: 429, body: Data()), .rateLimited)
        XCTAssertEqual(GeminiClient.failure(status: 503, body: Data()), .overloaded)
        XCTAssertEqual(GeminiClient.failure(status: 400, body: Data(#"{"error":{"message":"bad"}}"#.utf8)), .server(400, "bad"))
    }

    func testWhenOneServiceFailsTheOtherAnswersAndCarriesTheTurn() async throws {
        let claude = FakeClient(provider: .claude, result: .failure(ClaudeClient.Failure.overloaded))
        let gemini = FakeClient(provider: .gemini, result: .success("From Gemini."))
        let (response, order) = try await LocalBrain.send([claude, gemini], system: "", messages: [], tools: []) { _ in }
        XCTAssertEqual(response.text, "From Gemini.")
        XCTAssertEqual(order.map(\.provider), [.gemini, .claude])

        do {
            _ = try await LocalBrain.send([claude], system: "", messages: [], tools: []) { _ in }
            XCTFail("one service, failing: the failure comes back")
        } catch {
            XCTAssertEqual(error as? ClaudeClient.Failure, .overloaded)
        }
    }

    func testAFallbackSaysWhoAnsweredAndWhy() async throws {
        let gemini = FakeClient(provider: .gemini, result: .failure(GeminiClient.Failure.badKey))
        let apple = FakeClient(provider: .apple, result: .success("From Apple."))
        var skipped: [(BrainProvider, String)] = []
        let (_, order) = try await LocalBrain.send([gemini, apple], system: "", messages: [], tools: [], onSkip: { skipped.append(($0, $1)) }) { _ in }
        XCTAssertEqual(skipped.map(\.0), [.gemini])
        let note = try XCTUnwrap(LocalBrain.fallbackNote(answeredBy: order[0].provider, skipped: skipped))
        XCTAssertTrue(note.hasPrefix("Answered with Apple Intelligence. Gemini: "), note)
        XCTAssertTrue(note.contains("wasn’t accepted"), note)
        XCTAssertNil(LocalBrain.fallbackNote(answeredBy: .claude, skipped: []))
    }

    func testGoogleCloudKeysGoToVertexAndStudioKeysToTheGeminiAPI() {
        XCTAssertEqual(GeminiClient.endpoints(for: "AQ.Ab8RN6" + String(repeating: "x", count: 40)), [.vertex, .studio])
        XCTAssertEqual(GeminiClient.endpoints(for: "AIzaSy" + String(repeating: "x", count: 33)), [.studio, .vertex])
        XCTAssertEqual(GeminiClient.Endpoint.vertex.url(model: "gemini-flash-latest")?.absoluteString,
                       "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-flash-latest:streamGenerateContent?alt=sse")
        XCTAssertEqual(GeminiClient.Endpoint.studio.url(model: "gemini-flash-latest")?.host, "generativelanguage.googleapis.com")
        let key = "AIza-remembered-" + String(repeating: "y", count: 30)
        GeminiClient.Remembered.set(.vertex, for: key)
        XCTAssertEqual(GeminiClient.endpoints(for: key), [.vertex, .studio], "the door that took the key last time goes first")
        XCTAssertTrue(GeminiClient.Failure.server(404, "models/gemini-3.8-flash is not found").isNotFound)
        XCTAssertNil(BrainProvider.gemini.problem(with: "AQ.Ab8RN6" + String(repeating: "x", count: 40)))
    }
}

/// Jarvis on the iPhone without the Mac: who answers when the Mac can't be reached, and
/// what Apple's models are given.
final class OfflineBrainTests: XCTestCase {
    func testAMacThatCantBeReachedNeverLeavesAQuestionWaitingWhenTheIPhoneCanAnswer() {
        for mode in BrainMode.allCases {
            XCTAssertTrue(mode.answersOnPhone(paired: true, hasKey: false, canAnswer: true, macAway: true), "\(mode)")
            XCTAssertTrue(mode.answersOnPhone(paired: false, hasKey: false, canAnswer: false, macAway: false), "\(mode): no Mac")
            // Nothing on the iPhone can answer: it waits for the Mac, as before.
            XCTAssertEqual(mode.answersOnPhone(paired: true, hasKey: false, canAnswer: false, macAway: true), mode == .phone, "\(mode)")
        }
        // The Mac is there: the owner's choice, as before (Apple's model alone never takes over).
        XCTAssertFalse(BrainMode.mac.answersOnPhone(paired: true, hasKey: true, canAnswer: true, macAway: false))
        XCTAssertFalse(BrainMode.automatic.answersOnPhone(paired: true, hasKey: false, canAnswer: true, macAway: false))
        XCTAssertTrue(BrainMode.automatic.answersOnPhone(paired: true, hasKey: true, canAnswer: true, macAway: false))
        XCTAssertTrue(BrainMode.phone.answersOnPhone(paired: true, hasKey: false, canAnswer: true, macAway: false))
    }

    func testOnlyClaudeAndGeminiTakeKeys() {
        XCTAssertEqual(BrainProvider.keyed, [.claude, .gemini])
        XCTAssertNotNil(BrainProvider.apple.problem(with: "anything"))
    }

    func testAppleIsToldTheQuestionAndWhatItCantSee() {
        let messages: [JSONValue] = [
            ["role": "user", "content": [["type": "text", "text": "Hi"]]],
            ["role": "assistant", "content": [["type": "text", "text": "Hello."], ["type": "tool_use", "id": "t", "name": "weather", "input": [:]]]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "t", "content": "Sunny"]]],
            ["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": "x"]],
                ["type": "text", "text": "What is this?"],
            ]],
        ]
        let question = AppleClient.question(in: messages)
        XCTAssertTrue(question.hasPrefix("What is this?"))
        XCTAssertTrue(question.contains("can’t see"))
        XCTAssertEqual(AppleClient.history(messages, limit: 1000), "\n\nThe conversation so far:\nOwner: Hi\nJarvis: Hello.")
        XCTAssertEqual(AppleClient.history(messages, limit: 0), "")
        XCTAssertEqual(AppleClient.history(messages, limit: 16), "\n\nThe conversation so far:\nJarvis: Hello.", "the newest that fit")
    }

    @MainActor
    func testThePhonesToolsBecomeApplesWithTheirSchemas() {
        let definitions = PhoneTools().definitions()
        let all = AppleClient.tools(definitions, runner: { _, _ in "" }, everydayOnly: false)
        let names = Set(all.map(\.name))
        XCTAssertFalse(names.contains("web_search"), "Anthropic's server tools stay with Claude")
        XCTAssertTrue(names.isSuperset(of: AppleClient.everyday))
        XCTAssertEqual(all.count, definitions.filter { $0["type"] == nil }.count, "every tool's schema converts")
        let everyday = AppleClient.tools(definitions, runner: { _, _ in "" }, everydayOnly: true)
        XCTAssertEqual(Set(everyday.map(\.name)), AppleClient.everyday)
        XCTAssertNil(AppleClient.schema(for: ["name": "odd", "input_schema": ["type": "object", "properties": ["x": ["type": "array"]]]]))
    }

    func testWhatAppleGeneratesIsTheToolsJSONInput() throws {
        let content = try GeneratedContent(json: #"{"minutes":5,"label":"Tea"}"#)
        XCTAssertEqual(AppleClient.input(from: content)["label"], "Tea")
        XCTAssertEqual(AppleClient.input(from: content)["minutes"]?.doubleValue, 5)
    }
}

private struct FakeClient: BrainClient {
    let provider: BrainProvider
    let result: Result<String, Error>

    func send(system: String, messages: [JSONValue], tools: [JSONValue], onText: @escaping @Sendable (String) -> Void) async throws -> ClaudeClient.Response {
        let text = try result.get()
        return ClaudeClient.Response(content: [["type": "text", "text": .string(text)]], stopReason: "end_turn")
    }
}

/// What Jarvis on the iPhone learns: facts by kind, corrections it keeps, names it resolves.
@MainActor
final class MemoryTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testFactsKeptBeforeKindsStillLoadAsFacts() throws {
        let dir = try folder()
        try Data(#"[{"id":"7A1C1A52-8D1F-4E0E-9C2A-1B2C3D4E5F60","text":"Takes coffee black","date":0}]"#.utf8)
            .write(to: dir.appendingPathComponent("phone-memory.json"))
        let memory = LocalMemory(folder: dir)
        XCTAssertEqual(memory.facts.map(\.text), ["Takes coffee black"])
        XCTAssertEqual(memory.facts.first?.category, .fact)
    }

    func testTheMemoryGoesIntoThePromptByKindWithWhoNamesMean() throws {
        let memory = LocalMemory(folder: try folder())
        memory.add("Takes coffee black", kind: .preference)
        memory.add("Run a half marathon in March", kind: .goal)
        memory.add("Don't book flights before 8am", kind: .correction)
        memory.learn("Ann", contactID: "c-1", name: "Ann Lee")
        let prompt = memory.prompt
        XCTAssertTrue(prompt.contains("How the owner likes things:\n- Takes coffee black"))
        XCTAssertTrue(prompt.contains("The owner's goals:\n- Run a half marathon in March"))
        XCTAssertTrue(prompt.contains("never repeat these mistakes):\n- Don't book flights before 8am"))
        XCTAssertTrue(prompt.contains("\"ann\" means Ann Lee"))

        let reloaded = LocalMemory(folder: memory.folderForTests)
        XCTAssertEqual(reloaded.person("ANN ")?.name, "Ann Lee")
        XCTAssertEqual(reloaded.facts.count, 3)
    }

    func testANameLearnsWhoItMeansAndCanBeForgotten() throws {
        let memory = LocalMemory(folder: try folder())
        memory.learn("Ann", contactID: "c-1", name: "Ann Lee")
        memory.learn("ann", contactID: "c-1", name: "Ann Lee")
        XCTAssertEqual(memory.person("Ann")?.uses, 2)
        memory.learn("Ann", contactID: "c-2", name: "Ann Park")  // the owner said otherwise
        XCTAssertEqual(memory.person("Ann")?.name, "Ann Park")
        XCTAssertEqual(memory.person("Ann")?.uses, 1)
        memory.forgetPerson("Ann")
        XCTAssertNil(memory.person("Ann"))
    }

    func testCorrectionsAreTheLastToGo() throws {
        let memory = LocalMemory(folder: try folder())
        memory.add("Never call before 9", kind: .correction)
        for n in 0..<300 { memory.add("Fact \(n)") }
        XCTAssertEqual(memory.facts.count, 300)
        XCTAssertTrue(memory.facts.contains { $0.text == "Never call before 9" })
        XCTAssertFalse(memory.facts.contains { $0.text == "Fact 0" })
    }
}
