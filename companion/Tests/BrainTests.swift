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
}
